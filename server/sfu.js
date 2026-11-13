// FABRIC SFU: a selective forwarding unit for large calls. One instance is one media node; the
// relay can run one in its own process and use more (server/sfu-node.js) through server/sfu-cluster.js.
//
// Each member sends one audio stream and its video in up to three qualities (simulcast), and the
// node forwards them to everyone else in the room. It never decrypts: every frame is already
// encrypted end to end by the sender (frame E2EE with sender keys that travel only through the
// Double Ratchet), so a node sees RTP headers, sizes and timing, not sound or pictures. DTLS between
// a browser and a node is only a transport here, not what keeps the call private.
//
// Two connections per member:
//  - upload: the member offers it once (audio, simulcast video) and it is never renegotiated. Chrome
//    drops a video sender's frame transform when that connection is renegotiated, which would send
//    the picture to the node unencrypted, so the upload must stay as negotiated.
//  - download: the node offers it and renegotiates when someone joins or leaves. Each
//    subscription gets a pair of send transceivers, reused after a member leaves, so the SDP stays
//    bounded by the largest the room has been.
//
// Simulcast: each viewer gets one layer of each video it shows, chosen from the quality it asks
// for (by tile size) and the layers the sender is actually producing right now (a sender short of
// bandwidth stops its top layer). Switching waits for a keyframe of the new layer, and sequence
// numbers, timestamps and VP8 picture ids are rewritten so the viewer sees one continuous stream.
//
// Several nodes per room: when a room spills onto a second node, the nodes are joined by a link
// (an authenticated WebSocket, see sfu-node.js). Over it each node announces its members, which
// layers they produce and which layers its own viewers need, and forwards those RTP packets, still
// encrypted. A member on another node is subscribed to like a local one.
//
//   client → node   sfu_join    { room }                  join (creates the room if new)
//                   sfu_publish { room, sdp }             upload offer → sfu_published { sdp }
//                   sfu_answer  { room, sdp }             answer to the latest sfu_offer
//                   sfu_view    { room, videos: [addr], quality: { addr: 'l'|'m'|'h' } }
//                   sfu_leave   { room }
//   node → client   sfu_offer   { room, sdp, streams: {mid: {addr, kind}} }   (download)
//                   sfu_members { room, members: [addr] }
//                   sfu_closed  { room, reason }
import {
  RTCPeerConnection, RTCRtpCodecParameters, RtpPacket, useOPUS, useVP8, useSdesMid, useAbsSendTime, useSdesRTPStreamId,
  useRepairedRtpStreamId, useTWCC, useTransportWideCC,
} from 'werift';
import { createLayerForwarder, pickLayer, qualityFor, isQuality } from './simulcast.js';

export const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const MAX_ROOM = 50;
export const MAX_VIEW = 9;          // videos forwarded to one member at a time
const MAX_ROOMS = 200;
const ANSWER_MS = 15_000;           // a member that doesn't answer an offer this long is removed
const GATHER_MS = 2000;
const PLI_MIN_MS = 500;             // keyframe requests to one layer of one sender, at most this often
const LAYER_IDLE_MS = 1200;         // a layer with no packet for this long is not being sent
const TICK_MS = 300;                // layer choice, link reports
const MAX_SDP = 200_000;
const ADDR_RE = /^@[a-z0-9_]{2,24}\.veil#[A-Za-z0-9_-]{8,64}$/;
const RID_CODE = { '': 0, l: 1, m: 2, h: 3 };
const CODE_RID = ['', 'l', 'm', 'h'];

function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, GATHER_MS);
    const sub = pc.iceGatheringStateChange.subscribe((s) => {
      if (s === 'complete') { clearTimeout(t); sub.unSubscribe?.(); resolve(); }
    });
  });
}

/** A copy of the packet without its header extensions (their ids are per-connection). */
function bare(rtp) {
  const p = rtp.clone();
  p.header.extension = false;
  p.header.extensions = [];
  return p;
}

const validSdp = (sdp) => typeof sdp === 'string' && sdp.length <= MAX_SDP && sdp.startsWith('v=0');

/** RTP over a node link: kind, layer and sender, then the packet as received. */
export function encodeLinkRtp(addr, kind, rid, rtpBuf) {
  const a = Buffer.from(addr);
  return Buffer.concat([Buffer.from([kind === 'video' ? 1 : 0, RID_CODE[rid] ?? 0, a.length]), a, rtpBuf]);
}
export function decodeLinkRtp(buf) {
  if (buf.length < 3 + 12) return null;
  const kind = buf[0] === 1 ? 'video' : 'audio';
  const rid = CODE_RID[buf[1]];
  const n = buf[2];
  if (rid === undefined || buf.length < 3 + n + 12) return null;
  const addr = buf.subarray(3, 3 + n).toString();
  if (!ADDR_RE.test(addr)) return null;
  return { addr, kind, rid, rtp: buf.subarray(3 + n) };
}

/**
 * @param {object} o
 * @param {(addr: string, msg: object) => void} o.send   deliver a message to a member's socket
 * @param {(line: string) => void} [o.log]
 * @param {object} [o.pcConfig]                         extra werift RTCPeerConnection options
 * @param {(room: string, members: number) => void} [o.onRoom]   local membership changed
 */
export function createSfu({ send, log = () => {}, pcConfig = {}, maxRoom = MAX_ROOM, onRoom = () => {} }) {
  const rooms = new Map(); // room id → { id, peers: Map(addr → Peer), sources: Map(addr → Source), links: Set }
  const roomOf = new Map(); // local member addr → room id

  // the upload answers with transport-wide congestion feedback: without it a browser never learns
  // how much it can send, stays at its starting bitrate and only ever sends the lowest layer
  const vp8Upload = () => { const c = useVP8(); return new RTCRtpCodecParameters({ ...c, rtcpFeedback: [...c.rtcpFeedback, useTWCC()] }); };

  function newPc({ upload = false } = {}) {
    return new RTCPeerConnection({
      codecs: { audio: [useOPUS()], video: [upload ? vp8Upload() : useVP8()] },
      // mid lets browsers route by m-line; abs-send-time feeds their bandwidth estimate; the
      // upload also reads each simulcast layer's rid and sends transport-cc feedback
      headerExtensions: {
        audio: [useSdesMid()],
        video: upload
          ? [useSdesMid(), useAbsSendTime(), useSdesRTPStreamId(), useRepairedRtpStreamId(), useTransportWideCC()]
          : [useSdesMid(), useAbsSendTime()],
      },
      ...pcConfig,
    });
  }

  function getRoom(id) {
    let room = rooms.get(id);
    if (!room) { room = { id, peers: new Map(), sources: new Map(), links: new Set() }; rooms.set(id, room); }
    return room;
  }

  const members = (room) => [...room.sources.keys()];
  function membersMsg(room) {
    const list = members(room);
    for (const p of room.peers.values()) send(p.addr, { type: 'sfu_members', room: room.id, members: list });
  }

  // ---------- sources: a member's media, here or on another node ----------
  function newSource(addr, link = null) {
    return { addr, link, layers: new Map(), lastPli: new Map(), rx: null };
  }

  function available(src, now = Date.now()) {
    const out = [];
    for (const [rid, l] of src.layers) if (now - l.at < LAYER_IDLE_MS) out.push(rid);
    return out;
  }

  /** Ask a sender for a keyframe on one layer (at most every PLI_MIN_MS). */
  function keyframe(src, rid) {
    if (!src || rid == null) return;
    const now = Date.now();
    if (now - (src.lastPli.get(rid) || 0) < PLI_MIN_MS) return;
    src.lastPli.set(rid, now);
    if (src.link) return src.link.send({ t: 'pli', addr: src.addr, rid });
    const ssrc = src.layers.get(rid)?.ssrc;
    if (src.rx && ssrc != null) { try { src.rx.sendRtcpPLI(ssrc); } catch { /* not connected yet */ } }
  }

  // ---------- forwarding ----------
  /** A member's view: the videos it asked for, or (until it asks) the first MAX_VIEW publishers. */
  function sees(p, addr) {
    if (p.view) return p.view.has(addr);
    return [...p.subs.keys()].indexOf(addr) < MAX_VIEW;
  }

  function wantOf(p, addr) {
    if (isQuality(p.quality?.[addr])) return p.quality[addr];
    const order = p.view ? [...p.view] : [...p.subs.keys()].slice(0, MAX_VIEW);
    return qualityFor(Math.max(0, order.indexOf(addr)), order.length);
  }

  /** Point one viewer's copy of one video at the right layer. */
  function retarget(p, slot, src, now = Date.now()) {
    const avail = available(src, now);
    const target = pickLayer(avail, wantOf(p, src.addr));
    if (target === null) return;
    const cur = slot.fwd.current;
    const curGone = cur === null || !avail.includes(cur);
    if (slot.fwd.target(target, { immediate: curGone })) keyframe(src, target);
  }

  function forward(room, src, kind, rid, rtp) {
    const now = Date.now();
    if (kind === 'video') {
      const layer = src.layers.get(rid);
      if (layer) { layer.at = now; layer.ssrc = rtp.header.ssrc; } else src.layers.set(rid, { at: now, ssrc: rtp.header.ssrc });
    }
    let audioPkt = null;
    for (const p of room.peers.values()) {
      if (p.addr === src.addr) continue;
      const slot = p.subs.get(src.addr);
      if (!slot) continue;
      if (kind === 'audio') {
        audioPkt ??= bare(rtp);
        slot.audio.sender.sendRtp(audioPkt).catch(() => {});
        continue;
      }
      if (!sees(p, src.addr)) continue;
      if (slot.fwd.current === null && slot.fwd.pending === null) retarget(p, slot, src, now);
      const r = slot.fwd.packet(rid, rtp.payload);
      if (!r) continue;
      const out = bare(rtp);
      out.payload = r.payload;
      if (r.switched) {
        // continue the viewer's stream: next sequence number, timestamp advanced by the gap
        const step = slot.lastSentAt ? Math.max(1, Math.round((now - slot.lastSentAt) * 90)) : 1;
        slot.video.sender.replaceRTP(out.header, false, step);
      }
      slot.lastSentAt = now;
      slot.video.sender.sendRtp(out).catch(() => {});
    }
    // members here go to other nodes too, for the layers their viewers need
    if (!src.link) for (const link of room.links) link.forward(src.addr, kind, rid, rtp);
  }

  // ---------- upload (the member offers) ----------
  async function publish(addr, roomId, sdp) {
    const room = rooms.get(roomId);
    const p = room?.peers.get(addr);
    if (!p) return 'join first';
    if (p.upPc) return 'already publishing';
    if (!validSdp(sdp)) return 'bad sdp';
    const pc = p.upPc = newPc({ upload: true });
    const src = room.sources.get(addr);
    let audio = false;
    const rids = new Set();
    pc.connectionStateChange.subscribe((s) => { if (s === 'failed') leave(addr, 'failed'); });
    pc.onRemoteTransceiverAdded.subscribe((t) => {
      t.onTrack.subscribe((track) => {
        if (track.kind === 'audio') {
          if (audio) return; // one audio stream per member
          audio = true;
          track.onReceiveRtp.subscribe((rtp) => forward(room, src, 'audio', '', rtp));
          return;
        }
        const rid = typeof track.rid === 'string' && RID_CODE[track.rid] ? track.rid : '';
        if (rids.has(rid) || (rids.size && !rid)) return; // one video, in up to three layers
        rids.add(rid);
        src.rx = t.receiver;
        track.onReceiveRtp.subscribe((rtp) => forward(room, src, 'video', rid, rtp));
      });
    });
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      for (const t of pc.getTransceivers()) t.setDirection('recvonly');
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
    } catch (e) {
      log(`[sfu] upload from ${addr} rejected: ${e.message || e}`);
      leave(addr, 'bad offer');
      return 'bad sdp';
    }
    if (p.closed) return 'left';
    return { type: 'sfu_published', room: roomId, sdp: pc.localDescription.sdp };
  }

  // ---------- download (the node offers) ----------
  function subscribe(p, src) {
    if (p.subs.has(src.addr) || p.addr === src.addr) return;
    const slot = p.free.pop() || {
      audio: p.pc.addTransceiver('audio', { direction: 'sendonly' }),
      video: p.pc.addTransceiver('video', { direction: 'sendonly' }),
    };
    slot.audio.setDirection('sendonly');
    slot.video.setDirection('sendonly');
    slot.addr = src.addr;
    slot.fwd = createLayerForwarder(); // a reused slot starts a fresh, continuous stream
    if (!slot.wired) {
      slot.wired = true;
      // a viewer that lost a picture asks the node; the node asks for the layer it forwards
      const pli = () => {
        const s = slot.addr && rooms.get(p.room)?.sources.get(slot.addr);
        keyframe(s, slot.fwd?.pending ?? slot.fwd?.current);
      };
      slot.video.sender.onPictureLossIndication.subscribe(pli);
      slot.video.sender.onKeyFrameRequest?.subscribe(pli);
    }
    p.subs.set(src.addr, slot);
  }

  function unsubscribe(p, addr) {
    const slot = p.subs.get(addr);
    if (!slot) return;
    p.subs.delete(addr);
    slot.addr = null;
    slot.audio.setDirection('inactive');
    slot.video.setDirection('inactive');
    p.free.push(slot);
  }

  async function negotiate(p) {
    if (p.closed || (!p.subs.size && !p.free.length)) return; // nothing to download yet
    if (p.pending) { p.again = true; return; }
    p.pending = true;
    p.again = false;
    try {
      await p.pc.setLocalDescription(await p.pc.createOffer());
      await gathered(p.pc);
      if (p.closed) return;
      const streams = {};
      for (const [addr, slot] of p.subs) {
        streams[slot.audio.mid] = { addr, kind: 'audio' };
        streams[slot.video.mid] = { addr, kind: 'video' };
      }
      send(p.addr, { type: 'sfu_offer', room: p.room, sdp: p.pc.localDescription.sdp, streams });
      clearTimeout(p.answerTimer);
      p.answerTimer = setTimeout(() => leave(p.addr, 'no answer'), ANSWER_MS);
    } catch (e) {
      log(`[sfu] offer to ${p.addr} failed: ${e.message || e}`);
      leave(p.addr, 'failed');
    }
  }

  async function answer(addr, roomId, sdp) {
    const room = rooms.get(roomId);
    const p = room?.peers.get(addr);
    if (!p || !p.pending) return;
    if (!validSdp(sdp)) return leave(addr, 'bad answer');
    clearTimeout(p.answerTimer);
    try {
      await p.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (e) {
      log(`[sfu] answer from ${addr} rejected: ${e.message || e}`);
      return leave(addr, 'bad answer');
    }
    p.pending = false;
    // the viewer is ready for these streams now: start each with a keyframe
    for (const [a, slot] of p.subs) keyframe(room.sources.get(a), slot.fwd.current ?? slot.fwd.pending);
    if (p.again) negotiate(p);
  }

  // ---------- sources joining and leaving (here or on a linked node) ----------
  function addSource(room, src) {
    room.sources.set(src.addr, src);
    for (const p of room.peers.values()) { subscribe(p, src); negotiate(p); }
  }

  function removeSource(room, addr) {
    room.sources.delete(addr);
    for (const p of room.peers.values()) {
      p.view?.delete(addr);
      if (p.subs.has(addr)) { unsubscribe(p, addr); negotiate(p); }
    }
  }

  function dropRoomIfEmpty(room) {
    if (room.peers.size) return false;
    for (const l of room.links) l.close(); // nothing to send or show here any more
    rooms.delete(room.id);
    return true;
  }

  // ---------- membership ----------
  function join(addr, roomId) {
    if (!ROOM_RE.test(String(roomId))) return 'bad room';
    if (roomOf.get(addr) === roomId) leave(addr, 'rejoined'); // a reconnect starts clean
    else if (roomOf.has(addr)) leave(addr, 'joined another room');
    if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) return 'relay busy';
    const room = getRoom(roomId);
    if (room.sources.size >= maxRoom) { dropRoomIfEmpty(room); return 'room full'; }

    const pc = newPc();
    const p = {
      addr, room: roomId, pc, upPc: null, subs: new Map(), free: [], view: null, quality: {},
      pending: false, again: false, closed: false,
    };
    pc.connectionStateChange.subscribe((s) => { if (s === 'failed') leave(addr, s); });
    room.peers.set(addr, p);
    roomOf.set(addr, roomId);
    for (const src of room.sources.values()) subscribe(p, src); // everyone already here
    addSource(room, newSource(addr)); // and the newcomer for everyone (negotiates every peer, p too)
    membersMsg(room);
    onRoom(roomId, room.peers.size);
    log(`[sfu] ${addr} joined a room (${room.sources.size} in it, ${room.peers.size} on this node)`);
    return { type: 'sfu_joined', room: roomId };
  }

  function leave(addr, reason = 'left') {
    const roomId = roomOf.get(addr);
    const room = roomId && rooms.get(roomId);
    const p = room?.peers.get(addr);
    roomOf.delete(addr);
    if (!p) return;
    p.closed = true;
    clearTimeout(p.answerTimer);
    room.peers.delete(addr);
    for (const pc of [p.pc, p.upPc]) { try { pc?.close(); } catch { /* already closed */ } }
    if (!['left', 'rejoined', 'disconnected'].includes(reason)) send(addr, { type: 'sfu_closed', room: roomId, reason });
    removeSource(room, addr);
    onRoom(roomId, room.peers.size);
    if (dropRoomIfEmpty(room)) return;
    membersMsg(room);
  }

  function view(addr, roomId, videos, quality) {
    const room = rooms.get(roomId);
    const p = room?.peers.get(addr);
    if (!p || !Array.isArray(videos)) return;
    const next = new Set(videos.filter((a) => typeof a === 'string' && p.subs.has(a)).slice(0, MAX_VIEW));
    const added = [...next].filter((a) => !p.view?.has(a) && !(p.view === null && sees(p, a)));
    p.view = next;
    p.quality = {};
    if (quality && typeof quality === 'object') for (const a of next) if (isQuality(quality[a])) p.quality[a] = quality[a];
    for (const a of next) {
      const src = room.sources.get(a);
      const slot = p.subs.get(a);
      if (src && slot) retarget(p, slot, src);
      if (added.includes(a)) keyframe(src, slot?.fwd.current ?? slot?.fwd.pending); // a newly shown video starts clean
    }
  }

  // ---------- links to other nodes hosting the same room ----------
  /**
   * Join this node's part of a room to another node's. `transport` is a connected, authenticated
   * channel: { send(obj), sendBinary(buf), close() }. Returns the handlers for what arrives on it.
   */
  function attachLink(roomId, transport, { peer = 'node' } = {}) {
    if (!ROOM_RE.test(String(roomId))) throw new Error('bad room');
    const room = getRoom(roomId);
    const link = {
      room, peer, closed: false,
      want: new Map(), // addr → Set(rid) the other node's viewers need from members here
      sent: { pubs: '', want: '' },
      send: (o) => { if (!link.closed) transport.send(o); },
      forward(addr, kind, rid, rtp) {
        if (link.closed) return;
        if (kind === 'video' && !link.want.get(addr)?.has(rid)) return;
        transport.sendBinary(encodeLinkRtp(addr, kind, rid, rtp.serialize()));
      },
      close() {
        if (link.closed) return;
        link.closed = true;
        try { transport.close(); } catch { /* gone */ }
        onClose();
      },
    };
    room.links.add(link);

    const mine = (addr) => { const s = room.sources.get(addr); return s?.link === link ? s : null; };
    function onMessage(m) {
      if (link.closed || !m || typeof m !== 'object') return;
      if (m.t === 'pubs' && Array.isArray(m.pubs)) {
        const now = new Set(m.pubs.filter((a) => typeof a === 'string' && ADDR_RE.test(a)).slice(0, maxRoom));
        for (const [addr, s] of room.sources) if (s.link === link && !now.has(addr)) removeSource(room, addr);
        for (const addr of now) if (!room.sources.has(addr)) addSource(room, newSource(addr, link));
        return membersMsg(room);
      }
      if (m.t === 'layers' && m.layers && typeof m.layers === 'object') {
        const at = Date.now();
        for (const [addr, rids] of Object.entries(m.layers)) {
          const s = mine(addr);
          if (!s || !Array.isArray(rids)) continue;
          for (const rid of rids) if (rid in RID_CODE) { const l = s.layers.get(rid); if (l) l.at = at; else s.layers.set(rid, { at, ssrc: null }); }
        }
        return;
      }
      if (m.t === 'want' && m.want && typeof m.want === 'object') {
        link.want = new Map();
        for (const [addr, rids] of Object.entries(m.want)) {
          const s = room.sources.get(addr);
          if (s && !s.link && Array.isArray(rids)) link.want.set(addr, new Set(rids.filter((r) => r in RID_CODE)));
        }
        return;
      }
      if (m.t === 'pli' && typeof m.addr === 'string') {
        const s = room.sources.get(m.addr);
        if (s && !s.link && m.rid in RID_CODE) keyframe(s, m.rid);
      }
    }
    function onBinary(buf) {
      if (link.closed) return;
      const d = decodeLinkRtp(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      const s = d && mine(d.addr);
      if (!s) return;
      let rtp;
      try { rtp = RtpPacket.deSerialize(Buffer.from(d.rtp)); } catch { return; }
      forward(room, s, d.kind, d.rid, rtp);
    }
    function onClose() {
      link.closed = true;
      if (!room.links.delete(link)) return;
      for (const [addr, s] of [...room.sources]) if (s.link === link) removeSource(room, addr);
      if (rooms.get(room.id) === room && !dropRoomIfEmpty(room)) membersMsg(room);
    }
    reportLink(link); // say who is here right away
    return { onMessage, onBinary, onClose, link };
  }

  /** What one link should know now: members here, their live layers, and what viewers here need. */
  function reportLink(link) {
    const { room } = link;
    const local = [...room.sources.values()].filter((s) => !s.link);
    const pubs = JSON.stringify(local.map((s) => s.addr).sort());
    if (pubs !== link.sent.pubs) { link.sent.pubs = pubs; link.send({ t: 'pubs', pubs: JSON.parse(pubs) }); }
    const now = Date.now();
    const layers = {};
    for (const s of local) { const a = available(s, now); if (a.length) layers[s.addr] = a; }
    if (Object.keys(layers).length) link.send({ t: 'layers', layers });
    const want = {};
    for (const p of room.peers.values()) {
      for (const [addr, slot] of p.subs) {
        const s = room.sources.get(addr);
        if (s?.link !== link || !sees(p, addr)) continue;
        const set = (want[addr] ??= new Set());
        for (const r of [slot.fwd.current, slot.fwd.pending]) if (r !== null) set.add(r);
        // a viewer with nothing yet needs to hear about some layer to start
        if (slot.fwd.current === null && slot.fwd.pending === null) { const r = pickLayer(available(s, now), wantOf(p, addr)); if (r !== null) set.add(r); }
      }
    }
    const w = JSON.stringify(Object.fromEntries(Object.entries(want).map(([a, s]) => [a, [...s].sort()])));
    if (w !== link.sent.want) { link.sent.want = w; link.send({ t: 'want', want: JSON.parse(w) }); }
  }

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const p of room.peers.values()) {
        for (const [addr, slot] of p.subs) {
          const src = room.sources.get(addr);
          if (src && sees(p, addr)) retarget(p, slot, src, now);
        }
      }
      for (const link of room.links) reportLink(link);
    }
  }, TICK_MS);
  ticker.unref?.();

  return {
    /**
     * A WebSocket message from an authenticated device: an error string, a reply object, or
     * null (nothing to say).
     */
    async ws(addr, msg) {
      switch (msg.type) {
        case 'sfu_join': return join(addr, msg.room);
        case 'sfu_publish': return publish(addr, msg.room, msg.sdp);
        case 'sfu_answer': await answer(addr, msg.room, msg.sdp); return null;
        case 'sfu_view': view(addr, msg.room, msg.videos, msg.quality); return null;
        case 'sfu_leave': if (roomOf.get(addr) === msg.room) leave(addr); return null;
        default: return 'unknown type';
      }
    },
    /** The device's socket closed. */
    gone(addr) { leave(addr, 'disconnected'); },
    attachLink,
    /** Which layer each viewer here gets of each video (for tests and diagnostics). */
    layersOf(addr) {
      const room = rooms.get(roomOf.get(addr));
      const p = room?.peers.get(addr);
      return p ? Object.fromEntries([...p.subs].map(([a, s]) => [a, s.fwd.current])) : null;
    },
    stats() {
      return { rooms: rooms.size, members: roomOf.size };
    },
    close() {
      clearInterval(ticker);
      for (const addr of [...roomOf.keys()]) leave(addr, 'relay stopping');
      for (const room of [...rooms.values()]) for (const l of [...room.links]) l.close();
    },
  };
}
