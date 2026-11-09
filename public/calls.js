// FABRIC voice & video calls, 1:1 and group: WebRTC media in a full mesh for small calls and
// through the relay's SFU for large ones, signaling over the Double Ratchet, frame E2EE with
// per-sender keys rotated on join, leave and every 10 minutes. The SFU only forwards frames it
// can't decrypt.
import {
  parseCallSignal, inviteExpired, glareYield, offersTo, mergeRoster, nextKid, formatDuration, preferRoom,
  CALL_RING_MS, MEDIA_KEY_BYTES, MAX_CALL_DEVICES, MAX_SFU_DEVICES, SFU_FROM, ROTATE_MS,
} from '/shared/callproto.js';
import { b64, unb64, newMessageId } from '/shared/crypto.js';
import { deviceAddr, parseAddr } from '/shared/devices.js';

const $ = (id) => document.getElementById(id);
// ?media=test sends a generated tone + test pattern instead of the camera, microphone and screen
const MEDIA_TEST = new URLSearchParams(location.search).get('media') === 'test';
const SWITCH_MS = 1000;      // a new sender key goes out first and is used this long after
const DROP_MS = 10_000;      // a link that stays disconnected this long counts as gone
const STASH_MS = 15_000;     // an offer from someone not (yet) announced waits this long
const NOTE_MS = 5000;
const QS = new URLSearchParams(location.search);
// ?sfuFrom=3 moves calls to the SFU sooner (for trying it out with a few tabs)
const SFU_AT = Math.max(2, Number(QS.get('sfuFrom')) || SFU_FROM);
const VIEW_MAX = 9;          // videos the SFU forwards to me at once: presenters, then recent speakers
// my video to the SFU in three qualities (rid l, m, h); it forwards each viewer the one it needs
const SIMULCAST = [
  { rid: 'l', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { rid: 'm', scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { rid: 'h', maxBitrate: 1_500_000 },
];
// same rule as the SFU's (server/simulcast.js): the first tile is big, a crowded grid is small
const qualityFor = (position, shown) => (shown <= 2 || position === 0 ? 'h' : shown <= 4 ? 'm' : 'l');
const SPEAKING = 0.02;       // audio level that counts as speaking
const SFU_GONE_MS = 10_000;  // a member out of the SFU room this long has dropped

/** Which frame-transform API this browser has, if any. */
export function frameE2eeMode() {
  if ('RTCRtpScriptTransform' in globalThis) return 'script';
  if (globalThis.RTCRtpSender && 'createEncodedStreams' in RTCRtpSender.prototype) return 'legacy';
  return null;
}

// Product names: FabVoice™ (voice calls) and FabVid™ (video calls); FabText™ is messaging.
const word = (video) => (video ? 'FabVid' : 'FabVoice');
const Word = word;
const handleOf = (addr) => parseAddr(addr).handle;
const canShareScreen = () => MEDIA_TEST || Boolean(navigator.mediaDevices?.getDisplayMedia);

/**
 * @param {object} o
 * @param {() => string} o.me                        my handle
 * @param {() => string} o.myDevice                  my device id
 * @param {(peer: string) => Promise<object[]>} o.devicesOf  verified devices of an account
 * @param {() => string[]} o.contacts                people that can be added to a call
 * @param {(addr: string, payload: object) => Promise<void>} o.send  encrypt + send to one device
 * @param {(peer: string, text: string) => void} o.log        add a line to the conversation
 * @param {() => void} [o.feature]                    report feature use (counted only if opted in)
 * @param {{request: (m: object) => Promise<object>, post: (m: object) => void}} [o.relay]  SFU messages
 */
export function createCalls({ me, myDevice, devicesOf, contacts = () => [], send, log, feature = () => {}, relay = null }) {
  const mode = frameE2eeMode();
  let call = null;

  // the call is passed in, not read from `call`, because it may already be cleared
  const signalFor = (c, addrs, op, extra = {}) => {
    for (const a of addrs) if (a) send(a, { kind: 'call', op, id: c.id, ...extra }).catch((e) => console.warn('call signal', op, e.message));
  };
  const others = (c) => [...c.members].filter((a) => a !== c.me);
  const linked = (c) => [...c.links.values()].filter((L) => L.addr);

  // ---------- local media ----------
  function tone() {
    try {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.02;
      osc.frequency.value = 330 + Math.floor(Math.random() * 6) * 55;
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      return { track: dest.stream.getAudioTracks()[0], stop: () => ac.close() };
    } catch {
      return { track: null, stop: () => {} };
    }
  }

  function pattern(label, screen = false) {
    const canvas = document.createElement('canvas');
    canvas.width = screen ? 1280 : 640;
    canvas.height = screen ? 720 : 480;
    const g = canvas.getContext('2d');
    let f = 0;
    const draw = () => {
      g.fillStyle = screen ? '#0d1626' : `hsl(${(f * 3) % 360} 55% 32%)`;
      g.fillRect(0, 0, canvas.width, canvas.height);
      if (screen) {
        g.fillStyle = '#1f6feb';
        g.fillRect(24, 64 + ((f * 4) % 220), 200, 18);
        g.strokeStyle = '#3d4a5c';
        for (let y = 64; y < canvas.height; y += 30) g.strokeRect(260, y, 340, 20);
      }
      g.fillStyle = '#fff';
      g.font = '600 22px system-ui, sans-serif';
      g.fillText(label, 18, 40);
      g.font = '15px system-ui, sans-serif';
      g.fillText(`${screen ? 'test screen' : 'test pattern'} · frame ${f++}`, 18, canvas.height - 18);
    };
    draw();
    const timer = setInterval(draw, 66);
    const track = canvas.captureStream(15).getVideoTracks()[0];
    return { track, stop: () => { clearInterval(timer); track.stop(); } };
  }

  async function getMic() {
    if (!MEDIA_TEST && navigator.mediaDevices?.getUserMedia) {
      try {
        const track = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
        return { track, test: false, stop: () => track.stop() };
      } catch (e) {
        console.warn('no microphone, sending a test tone instead:', e.message);
      }
    }
    return { ...tone(), test: true };
  }

  async function getCam() {
    if (!MEDIA_TEST && navigator.mediaDevices?.getUserMedia) {
      try {
        const track = (await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })).getVideoTracks()[0];
        return { track, test: false, stop: () => track.stop() };
      } catch (e) {
        console.warn('no camera, sending a test pattern instead:', e.message);
      }
    }
    return { ...pattern(me()), test: true };
  }

  async function getScreen() {
    if (!MEDIA_TEST) {
      // throws if the person cancels the picker
      const track = (await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })).getVideoTracks()[0];
      track.contentHint = 'detail';
      return { track, test: false, stop: () => track.stop() };
    }
    return { ...pattern(`${me()} · shared screen`, true), test: true };
  }

  const videoTrack = (c) => c.screen?.track || c.cam?.track || null;

  // ---------- frame encryption ----------
  function newWorker(c) {
    const w = new Worker('/e2ee-worker.js', { type: 'module' });
    w.onmessage = (e) => { if (e.data?.type === 'stats' && call === c) { c.stats = e.data; render(); } };
    return w;
  }

  const attached = new WeakSet();
  function attach(c, obj, dir, kind, L) {
    if (!c.worker || attached.has(obj)) return;
    attached.add(obj);
    const options = { dir, kind, peer: L.tag };
    if (mode === 'script') {
      obj.transform = new RTCRtpScriptTransform(c.worker, options);
    } else {
      const { readable, writable } = obj.createEncodedStreams();
      c.worker.postMessage({ type: 'stream', readable, writable, ...options }, [readable, writable]);
    }
  }

  function newKey(c) {
    c.key = globalThis.crypto.getRandomValues(new Uint8Array(MEDIA_KEY_BYTES));
    c.kid = c.kid === undefined ? 0 : nextKid(c.kid);
  }

  const keyFields = (c) => (c.worker ? { e2ee: true, key: b64(c.key), kid: c.kid } : { e2ee: false });

  /** A new sender key: tell every member present now, then start using it. */
  function rotate(c) {
    if (!c.worker || call !== c) return;
    newKey(c);
    const { key, kid } = c;
    signalFor(c, others(c), 'key', { key: b64(key), kid });
    clearTimeout(c.switchTimer);
    c.switchTimer = setTimeout(() => c.worker?.postMessage({ type: 'send-key', kid, key }), SWITCH_MS);
    c.rotations++;
  }

  // A member's keys live in the worker under 'k:' + address (used by SFU slots) and, for a mesh
  // link, under the link's tag too.
  const keyTag = (addr) => 'k:' + addr;

  /** A media key from `addr`. Kept until they are a member, then handed to the worker. */
  function learnKey(c, addr, m) {
    if (!m?.key) return;
    const keys = c.peerKeys.get(addr) || [];
    if (!keys.some((k) => k.kid === m.kid && k.key === m.key)) keys.push({ kid: m.kid, key: m.key });
    while (keys.length > 2) keys.shift();
    c.peerKeys.set(addr, keys);
    if (c.peerKeys.size > MAX_SFU_DEVICES * 2) c.peerKeys.delete(c.peerKeys.keys().next().value);
    if (c.members.has(addr)) applyKeys(c, addr);
  }

  function applyKeys(c, addr) {
    if (!c.worker) return;
    const L = c.links.get(addr);
    for (const k of c.peerKeys.get(addr) || []) {
      const key = unb64(k.key);
      c.worker.postMessage({ type: 'recv-key', peer: keyTag(addr), kid: k.kid, key });
      if (L?.e2ee) c.worker.postMessage({ type: 'recv-key', peer: L.tag, kid: k.kid, key });
    }
  }

  function takeKey(c, L, m) {
    if (!c.worker) return;
    if (!m.e2ee) { c.worker.postMessage({ type: 'plain', peer: L.tag }); return; }
    L.e2ee = true;
    learnKey(c, L.addr, m);
    applyKeys(c, L.addr);
  }

  // ---------- peer connections (one per other device) ----------
  function newLink(addr) {
    return {
      addr, handle: addr ? handleOf(addr) : null, tag: 'l' + newMessageId(),
      pc: null, state: 'connecting', audio: new MediaStream(), video: new MediaStream(), screen: false, e2ee: false,
    };
  }

  // STUN/TURN for this call. With the operator's TURN, a time-limited login comes over the signed-in
  // relay socket and is fetched again once half its lifetime is gone.
  let iceCache = null;
  async function relayInfo(c) {
    if (iceCache && (!iceCache.expires || iceCache.expires - Date.now() > iceCache.ttl / 2)) return (c.ice = iceCache.info);
    const info = await fetch('/api/ice').then((r) => r.json()).catch(() => ({ iceServers: [] }));
    let entry = { info, expires: null, ttl: 0 };
    if (info.turn && relay) {
      try {
        const r = await relay.request({ type: 'ice' });
        entry = { info: { ...info, iceServers: r.iceServers }, expires: r.expires, ttl: r.expires - Date.now() };
      } catch (e) { console.warn('TURN login', e); }
    }
    iceCache = entry;
    return (c.ice = entry.info);
  }
  const iceServers = async (c) => (await relayInfo(c)).iceServers || [];
  // the SFU only ever sees frames encrypted here, so a browser without frame encryption stays in the mesh
  const sfuOk = async (c) => Boolean(c.worker && relay && (await relayInfo(c)).sfu);
  const capOf = (c) => (c.canSfu ? MAX_SFU_DEVICES : MAX_CALL_DEVICES);

  async function newPc(c, L) {
    const config = { iceServers: await iceServers(c) };
    if (mode === 'legacy') config.encodedInsertableStreams = true;
    const pc = L.pc = new RTCPeerConnection(config);
    pc.ontrack = (ev) => {
      attach(c, ev.receiver, 'recv', ev.track.kind, L);
      const s = ev.track.kind === 'audio' ? L.audio : L.video;
      if (!s.getTracks().includes(ev.track)) s.addTrack(ev.track);
      ev.track.onmute = render;
      ev.track.onunmute = render;
      render();
    };
    pc.onconnectionstatechange = () => onLinkState(c, L);
    return pc;
  }

  /** Frame encryption keeps a few codec header bytes clear; those offsets are VP8's. */
  function preferVp8(t) {
    const caps = globalThis.RTCRtpReceiver?.getCapabilities?.('video');
    if (!caps || !t?.setCodecPreferences) return;
    const vp8 = caps.codecs.filter((x) => /vp8/i.test(x.mimeType));
    const helpers = caps.codecs.filter((x) => /rtx|red|ulpfec|flexfec/i.test(x.mimeType));
    try { t.setCodecPreferences([...vp8, ...helpers]); } catch (e) { console.warn('codec preference', e); }
  }

  // Every link always has one audio and one video transceiver, even in a voice call, so turning
  // the camera on or sharing a screen later is a track swap, not a renegotiation.
  function secure(c, L) {
    for (const t of [L.audioTx, L.videoTx]) {
      if (!t) continue;
      const kind = t.receiver.track.kind;
      attach(c, t.sender, 'send', kind, L);
      attach(c, t.receiver, 'recv', kind, L); // now: Chrome ignores a transform attached later in ontrack
    }
    if (c.worker) preferVp8(L.videoTx);
  }

  function gathered(pc, ms = 3000) {
    // one round trip with complete candidates instead of trickling each through the ratchet
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  async function makeOffer(c, L) {
    const pc = await newPc(c, L);
    L.audioTx = pc.addTransceiver(c.mic?.track || 'audio', { direction: 'sendrecv' });
    L.videoTx = pc.addTransceiver(videoTrack(c) || 'video', { direction: 'sendrecv' });
    secure(c, L);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return pc.localDescription.sdp;
  }

  async function makeAnswer(c, L, sdp) {
    const pc = await newPc(c, L);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      if (kind === 'audio' && !L.audioTx) L.audioTx = t;
      else if (kind === 'video' && !L.videoTx) L.videoTx = t;
      else continue;
      t.direction = 'sendrecv';
    }
    secure(c, L); // before the tracks: Chrome skips a sender transform set after replaceTrack
    await L.audioTx?.sender.replaceTrack(c.mic?.track || null);
    await L.videoTx?.sender.replaceTrack(videoTrack(c));
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return pc.localDescription.sdp;
  }

  function closeLink(c, L) {
    if (!L) return;
    clearTimeout(L.dropTimer);
    try { L.pc?.close(); } catch { /* already closed */ }
    c.worker?.postMessage({ type: 'drop-peer', peer: L.tag });
    L.el?.remove();
  }

  /** Tell a newly linked member what they need to know about my side. */
  function greet(c, addr) {
    if (c.screen) signalFor(c, [addr], 'media', { screen: true });
  }

  // ---------- the SFU (large calls) ----------
  // One connection to the relay carries my audio and video up and everyone else's down. Each
  // incoming slot is decrypted with the key of the member the relay says is on it.
  function newRoomId() {
    return b64(globalThis.crypto.getRandomValues(new Uint8Array(18))).replace(/[+/=]/g, (x) => ({ '+': '-', '/': '_', '=': '' })[x]);
  }

  async function joinSfu(c, room) {
    if (c.sfu?.room === room || call !== c) return;
    if (c.sfu) leaveSfu(c, false);
    const S = c.sfu = { room, pc: null, up: null, streams: {}, peers: new Map(), inRoom: new Set(), goneTimers: new Map(), levels: new Map(), view: '' };
    try {
      await relay.request({ type: 'sfu_join', room });
      if (c.sfu !== S) return;
      await publishSfu(c, S);
    } catch (e) {
      if (c.sfu !== S) return;
      leaveSfu(c);
      note(c, `large call unavailable: ${e.message}`);
      return;
    }
    if (call !== c || c.sfu !== S) return;
    S.statsTimer = setInterval(() => sfuTick(c, S), 1000);
    render();
  }

  function leaveSfu(c, tell = true) {
    const S = c.sfu;
    if (!S) return;
    c.sfu = null;
    clearInterval(S.statsTimer);
    for (const t of S.goneTimers.values()) clearTimeout(t);
    if (tell) relay?.post({ type: 'sfu_leave', room: S.room });
    for (const pc of [S.pc, S.up]) { try { pc?.close(); } catch { /* already closed */ } }
    for (const p of S.peers.values()) p.el?.remove();
  }

  async function sfuPcConfig(c) {
    const config = { iceServers: await iceServers(c) };
    if (mode === 'legacy') config.encodedInsertableStreams = true;
    return config;
  }

  /**
   * My upload: offered by me, like a mesh link, and never renegotiated. (Chrome drops a video
   * sender's frame transform when its connection is renegotiated, which would hand the relay my
   * picture unencrypted, so the renegotiated download connection never carries my media.)
   */
  async function publishSfu(c, S) {
    const pc = S.up = new RTCPeerConnection(await sfuPcConfig(c));
    pc.onconnectionstatechange = () => {
      if (c.sfu === S && S.up === pc && pc.connectionState === 'failed') rejoinSfu(c);
    };
    S.audioTx = pc.addTransceiver(c.mic?.track || 'audio', { direction: 'sendonly' });
    // simulcast: three qualities, so the SFU can send a small tile a small picture. Set here
    // because this connection is never renegotiated (and setParameters can't add layers).
    S.videoTx = pc.addTransceiver(videoTrack(c) || 'video', { direction: 'sendonly', sendEncodings: SIMULCAST });
    attach(c, S.audioTx.sender, 'send', 'audio', { tag: 'sfu:me' });
    attach(c, S.videoTx.sender, 'send', 'video', { tag: 'sfu:me' });
    preferVp8(S.videoTx);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (c.sfu !== S) return;
    const r = await relay.request({ type: 'sfu_publish', room: S.room, sdp: pc.localDescription.sdp });
    if (c.sfu !== S) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
  }

  async function newSfuPc(c, S) {
    const pc = new RTCPeerConnection(await sfuPcConfig(c));
    // during setRemoteDescription: on a new connection Chrome skips a transform attached after it
    pc.ontrack = (ev) => attach(c, ev.receiver, 'recv', ev.track.kind, { tag: 'sfu:' + ev.transceiver.mid });
    pc.onconnectionstatechange = () => {
      if (c.sfu !== S || S.pc !== pc) return;
      if (pc.connectionState === 'connected' && !c.startedAt) {
        c.startedAt = Date.now();
        c.tick = setInterval(render, 1000);
      }
      if (pc.connectionState === 'failed') rejoinSfu(c);
      settle(c);
    };
    return pc;
  }

  /** The relay's (re)negotiation of my download: one pair of slots per other member. */
  async function onSfuOffer(c, m) {
    const S = c.sfu;
    if (!S || m.room !== S.room) return;
    S.chain = (S.chain || Promise.resolve()).then(async () => {
      if (c.sfu !== S) return;
      S.pc ??= await newSfuPc(c, S);
      const pc = S.pc;
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      for (const t of pc.getTransceivers()) {
        t.direction = 'recvonly'; // this connection never sends
        attach(c, t.receiver, 'recv', t.receiver.track.kind, { tag: 'sfu:' + t.mid });
        const s = m.streams?.[t.mid];
        c.worker.postMessage({ type: 'route', tag: 'sfu:' + t.mid, peer: s ? keyTag(s.addr) : null });
      }
      S.streams = m.streams || {};
      mapStreams(c, S);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      if (c.sfu !== S) return;
      relay.post({ type: 'sfu_answer', room: S.room, sdp: pc.localDescription.sdp });
      settle(c);
    }).catch((e) => {
      console.warn('sfu offer', e);
      if (c.sfu === S) rejoinSfu(c);
    });
  }

  /** One media source per member that the relay forwards to me. */
  function mapStreams(c, S) {
    const tracks = new Map(); // addr → { audio, video, mids }
    for (const t of S.pc.getTransceivers()) {
      const s = S.streams[t.mid];
      if (!s || !c.members.has(s.addr)) continue;
      const e = tracks.get(s.addr) || {};
      e[s.kind] = t.receiver.track;
      e[s.kind + 'Mid'] = t.mid;
      tracks.set(s.addr, e);
    }
    for (const [addr, p] of S.peers) {
      const e = tracks.get(addr);
      if (!e || e.audio !== p.audioTrack || e.video !== p.videoTrack) { p.el?.remove(); S.peers.delete(addr); }
    }
    for (const [addr, e] of tracks) {
      if (S.peers.has(addr)) continue;
      const p = {
        addr, handle: handleOf(addr), tag: keyTag(addr), state: 'active', e2ee: true, sfu: true,
        audio: new MediaStream(e.audio ? [e.audio] : []), video: new MediaStream(e.video ? [e.video] : []),
        audioTrack: e.audio, videoTrack: e.video, audioMid: e.audioMid,
      };
      for (const t of [e.audio, e.video]) if (t) { t.onmute = render; t.onunmute = render; }
      S.peers.set(addr, p);
    }
    render();
  }

  /** Once the relay carries a member to me, our mesh link (if any) is no longer needed. */
  function settle(c) {
    const S = c.sfu;
    if (!S?.pc || S.pc.connectionState !== 'connected') return render();
    for (const addr of S.peers.keys()) {
      const L = c.links.get(addr);
      if (L) { closeLink(c, L); c.links.delete(addr); }
    }
    updateState(c);
    render();
  }

  function rejoinSfu(c) {
    const S = c.sfu;
    if (!S || S.rejoining) return;
    S.rejoining = true;
    const room = S.room;
    leaveSfu(c);
    setTimeout(() => { if (call === c && !c.sfu) joinSfu(c, room); }, 1000);
  }

  /** Who the relay has in the room; someone gone from it for a while has dropped. */
  function onSfuMembers(c, m) {
    const S = c.sfu;
    if (!S || m.room !== S.room || !Array.isArray(m.members)) return;
    const now = new Set(m.members);
    for (const a of now) { clearTimeout(S.goneTimers.get(a)); S.goneTimers.delete(a); }
    for (const a of S.inRoom) {
      if (now.has(a) || a === c.me || S.goneTimers.has(a)) continue;
      S.goneTimers.set(a, setTimeout(() => {
        S.goneTimers.delete(a);
        if (c.sfu === S && !S.inRoom.has(a) && c.members.has(a)) dropMember(c, a, 'failed');
      }, SFU_GONE_MS));
    }
    S.inRoom = now;
  }

  /** Speaker focus: every second, ask the relay for presenters, then whoever spoke last. */
  async function sfuTick(c, S) {
    if (c.sfu !== S || !S.pc) return;
    try {
      const stats = await S.pc.getStats();
      const byMid = new Map([...S.peers.values()].map((p) => [p.audioMid, p]));
      stats.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'audio') return;
        const p = byMid.get(r.mid);
        if (p && r.audioLevel > SPEAKING) S.levels.set(p.addr, Date.now());
      });
    } catch { /* closed */ }
    const now = Date.now();
    for (const p of S.peers.values()) p.speaking = now - (S.levels.get(p.addr) || 0) < 1500;
    const order = [...S.peers.keys()].sort((a, b) =>
      (c.screens.has(b) - c.screens.has(a)) || ((S.levels.get(b) || 0) - (S.levels.get(a) || 0)));
    const videos = order.slice(0, VIEW_MAX);
    // the first tile is drawn large; a crowded grid needs only small pictures
    const quality = Object.fromEntries(videos.map((a, i) => [a, qualityFor(i, videos.length)]));
    const key = videos.map((a) => `${a}=${quality[a]}`).join(',');
    if (key !== S.view) {
      S.view = key;
      relay.post({ type: 'sfu_view', room: S.room, videos, quality });
    }
    S.shown = new Set(videos);
    render();
  }

  /** Move this call to the SFU (it is getting large): start a room and tell everyone. */
  async function escalate(c) {
    if (c.sfu || !c.canSfu) return;
    await joinSfu(c, newRoomId());
    if (c.sfu) broadcastRoster(c);
  }

  function onRelay(m) {
    const c = call;
    if (!c) return;
    if (m.type === 'sfu_offer') return onSfuOffer(c, m);
    if (m.type === 'sfu_members') return onSfuMembers(c, m);
    if (m.type === 'sfu_closed' && c.sfu?.room === m.room) return rejoinSfu(c);
  }

  /** The relay socket came back: the SFU forgot us with the old one. */
  function reconnected() {
    const c = call;
    if (c?.sfu) { const room = c.sfu.room; leaveSfu(c, false); joinSfu(c, room); }
  }

  // ---------- the call ----------
  function newCall(fields) {
    const myAddr = deviceAddr(me(), myDevice());
    return {
      me: myAddr, members: new Set([myAddr]), left: new Set(), links: new Map(), invites: new Map(),
      stash: new Map(), peerKeys: new Map(), seen: new Set(), cleanup: [], stats: null, rotations: 0,
      screens: new Set(), sfu: null, canSfu: false,
      ...fields,
    };
  }

  async function setupLocal(c, video) {
    c.mic = await getMic();
    c.cleanup.push(() => c.mic?.stop());
    if (video) c.cam = await getCam();
    c.cleanup.push(() => c.cam?.stop(), () => c.screen?.stop());
    if (mode) {
      c.worker = newWorker(c);
      newKey(c);
      c.worker.postMessage({ type: 'send-key', kid: c.kid, key: c.key });
      c.rotateTimer = setInterval(() => rotate(c), ROTATE_MS);
    }
    c.canSfu = await sfuOk(c);
  }

  const alone = (c) => c.members.size <= 1 && c.invites.size === 0;

  function note(c, text) {
    c.note = text;
    clearTimeout(c.noteTimer);
    c.noteTimer = setTimeout(() => { c.note = null; render(); }, NOTE_MS);
    render();
  }

  function updateState(c) {
    if (c.dir === 'in' && c.state === 'ringing') return;
    const live = linked(c).some((L) => L.state === 'active') || (c.sfu?.pc?.connectionState === 'connected' && c.sfu.peers.size > 0);
    if (live) c.state = 'active';
    else if (c.startedAt) c.state = 'reconnecting';
    else if (others(c).length) c.state = 'connecting';
    else if (c.invites.size) c.state = 'ringing';
  }

  // ---------- adding people ----------
  async function invite(c, handle) {
    if (handle === me()) throw new Error("you can't add yourself");
    if (c.invites.has(handle) || [...c.members].some((a) => handleOf(a) === handle)) return;
    if (c.members.size + c.invites.size >= capOf(c)) throw new Error(`a call can have up to ${capOf(c)} devices`);
    const devices = await devicesOf(handle);
    if (!devices.length) throw new Error(`${handle} has no devices`);
    if (c.members.size + c.invites.size + 1 >= SFU_AT) await escalate(c);
    const inv = { handle, targets: devices.map((d) => deviceAddr(handle, d.id)), link: c.sfu ? null : newLink(null) };
    c.invites.set(handle, inv);
    render();
    try {
      // through the SFU the invite carries the room instead of a connection offer
      const media = c.sfu ? { sfu: c.sfu.room } : { sdp: await makeOffer(c, inv.link) };
      if (call !== c || c.invites.get(handle) !== inv) return closeLink(c, inv.link);
      const msg = { kind: 'call', op: 'invite', id: c.id, video: c.video, ...media, ...keyFields(c) };
      await Promise.all(inv.targets.map((a) => send(a, msg).catch((e) => console.warn('invite', a, e))));
      inv.timer = setTimeout(() => {
        signalFor(c, inv.targets, 'hangup', { reason: 'no-answer' });
        inviteGone(c, inv, `no answer from ${handle}`, `No answer · ${word(c.video)} call`);
      }, CALL_RING_MS);
      updateState(c);
      render();
    } catch (e) {
      if (c.invites.get(handle) === inv) c.invites.delete(handle);
      closeLink(c, inv.link);
      throw e;
    }
  }

  function inviteGone(c, inv, noteText, endText) {
    if (call !== c || c.invites.get(inv.handle) !== inv) return;
    clearTimeout(inv.timer);
    c.invites.delete(inv.handle);
    closeLink(c, inv.link);
    if (alone(c)) return end(c, endText);
    note(c, noteText);
  }

  async function onAnswer(c, from, m, inv) {
    clearTimeout(inv.timer);
    c.invites.delete(inv.handle);
    signalFor(c, inv.targets.filter((a) => a !== from), 'hangup', { reason: 'answered-elsewhere' });
    const L = inv.link;
    c.members.add(from);
    c.left.delete(from);
    c.seen.add(inv.handle);
    if (!m.sdp || !L?.pc) {
      // they joined through the SFU
      closeLink(c, L);
      if (!m.sdp) learnKey(c, from, m);
      else { signalFor(c, [from], 'hangup', { reason: 'failed' }); return dropMember(c, from, 'failed'); }
      if (c.sfu?.pc) mapStreams(c, c.sfu);
    } else {
      L.addr = from;
      L.handle = inv.handle;
      c.links.get(from) && closeLink(c, c.links.get(from));
      c.links.set(from, L);
      takeKey(c, L, m);
      updateState(c);
      render();
      try {
        await L.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      } catch (e) {
        signalFor(c, [from], 'hangup', { reason: 'failed' });
        return dropMember(c, from, 'failed');
      }
    }
    updateState(c);
    render();
    greet(c, from);
    rotate(c);           // the new member must not be able to read what came before
    broadcastRoster(c);  // everyone else links up with them
  }

  // ---------- the mesh ----------
  function broadcastRoster(c) {
    signalFor(c, others(c), 'roster', { members: [...c.members], ...(c.sfu ? { sfu: c.sfu.room } : {}) });
  }

  async function onRoster(c, from, m) {
    if (!c.members.has(from) || (c.dir === 'in' && !c.answered)) return;
    if (m.sfu && c.canSfu && preferRoom(c.sfu?.room, m.sfu) !== c.sfu?.room) {
      await joinSfu(c, m.sfu); // the call has moved to the SFU (or two rooms met: the smaller wins)
      if (call !== c) return;
      broadcastRoster(c);
    }
    const fresh = m.members.filter((a) => !c.members.has(a) && !c.left.has(a) && handleOf(a) !== me());
    const ok = [];
    for (const a of fresh) {
      // only devices on that account's signed device list (this also pins a stranger's account)
      try {
        const devices = await devicesOf(handleOf(a));
        if (devices.some((d) => deviceAddr(handleOf(a), d.id) === a)) ok.push(a);
      } catch (e) {
        console.warn('roster: skipped', a, e.message);
      }
    }
    if (call !== c) return;
    const added = mergeRoster(c.members, ok, c.left, c.sfu ? MAX_SFU_DEVICES : MAX_CALL_DEVICES);
    if (!added.length) return;
    for (const a of added) {
      c.seen.add(handleOf(a));
      applyKeys(c, a); // a key they sent before I knew they were in the call
      if (c.sfu) continue; // the SFU carries them
      if (offersTo(c.me, a)) {
        connectTo(c, a);
      } else if (c.stash.has(a)) {
        const st = c.stash.get(a);
        c.stash.delete(a);
        onOffer(c, a, st);
      }
    }
    if (c.sfu?.pc) mapStreams(c, c.sfu);
    rotate(c);
    broadcastRoster(c);
    updateState(c);
    render();
  }

  async function connectTo(c, addr) {
    if (c.links.has(addr) || c.sfu) return;
    const L = newLink(addr);
    c.links.set(addr, L);
    try {
      const sdp = await makeOffer(c, L);
      if (call !== c || c.links.get(addr) !== L) return;
      await send(addr, { kind: 'call', op: 'offer', id: c.id, sdp, ...keyFields(c) });
    } catch (e) {
      console.warn('offer to', addr, e);
      dropMember(c, addr, 'failed');
    }
  }

  async function onOffer(c, from, m) {
    if (c.dir === 'in' && !c.answered) return;
    if (!c.members.has(from)) {
      // its roster announcement may still be on the way
      if (c.left.has(from)) return;
      c.stash.set(from, m);
      setTimeout(() => { if (c.stash.get(from) === m) c.stash.delete(from); }, STASH_MS);
      return;
    }
    const old = c.links.get(from);
    if (old) closeLink(c, old);
    const L = newLink(from);
    c.links.set(from, L);
    try {
      takeKey(c, L, m);
      const sdp = await makeAnswer(c, L, m.sdp);
      if (call !== c || c.links.get(from) !== L) return;
      await send(from, { kind: 'call', op: 'accept', id: c.id, sdp, ...keyFields(c) });
      greet(c, from);
    } catch (e) {
      console.warn('accept for', from, e);
      dropMember(c, from, 'failed');
    }
    render();
  }

  async function onAccept(c, from, m) {
    const L = c.links.get(from);
    if (!L || L.pc?.signalingState !== 'have-local-offer') return;
    takeKey(c, L, m);
    try {
      await L.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      greet(c, from);
    } catch (e) {
      console.warn('accept from', from, e);
      dropMember(c, from, 'failed');
    }
  }

  function dropMember(c, addr, reason) {
    if (call !== c || (!c.members.has(addr) && !c.links.has(addr))) return;
    c.members.delete(addr);
    c.left.add(addr);
    c.stash.delete(addr);
    c.peerKeys.delete(addr);
    c.screens.delete(addr);
    c.worker?.postMessage({ type: 'drop-peer', peer: keyTag(addr) });
    const L = c.links.get(addr);
    if (L) closeLink(c, L);
    c.links.delete(addr);
    const p = c.sfu?.peers.get(addr);
    if (p) { p.el?.remove(); c.sfu.peers.delete(addr); }
    if (alone(c)) return end(c, summary(c) || (reason === 'failed' ? 'Call failed' : `${Word(c.video)} call ended`));
    rotate(c); // whoever left must not be able to read what comes next
    updateState(c);
    note(c, `${handleOf(addr)} ${reason === 'failed' ? 'dropped' : 'left'}`);
  }

  function onLinkState(c, L) {
    if (call !== c || !L.pc || c.links.get(L.addr) !== L) return;
    const s = L.pc.connectionState;
    if (c.sfu && (s === 'failed' || s === 'closed' || s === 'disconnected')) {
      // the call moved to the SFU: a mesh link closing is not someone leaving
      closeLink(c, L);
      c.links.delete(L.addr);
      return render();
    }
    if (s === 'connected') {
      clearTimeout(L.dropTimer);
      L.state = 'active';
      if (!c.startedAt) {
        c.startedAt = Date.now();
        c.tick = setInterval(render, 1000);
      }
    } else if (s === 'disconnected') {
      L.state = 'reconnecting';
      clearTimeout(L.dropTimer);
      L.dropTimer = setTimeout(() => {
        if (call === c && L.pc.connectionState !== 'connected') {
          signalFor(c, [L.addr], 'hangup', { reason: 'failed' });
          dropMember(c, L.addr, 'failed');
        }
      }, DROP_MS);
    } else if (s === 'failed') {
      signalFor(c, [L.addr], 'hangup', { reason: 'failed' });
      return dropMember(c, L.addr, 'failed');
    }
    updateState(c);
    render();
  }

  // ---------- outgoing ----------
  async function start(peer, video) {
    if (call) return;
    const c = call = newCall({ id: newMessageId(), peer, dir: 'out', video, state: 'starting' });
    render();
    try {
      await setupLocal(c, video);
      if (call !== c) return;
      await invite(c, peer);
      if (call !== c) return;
      feature();
      render();
    } catch (e) {
      console.warn('call failed', e);
      for (const inv of c.invites.values()) signalFor(c, inv.targets, 'hangup', { reason: 'failed' });
      end(c, `Call failed: ${e.message}`);
    }
  }

  async function add(handle) {
    const c = call;
    if (!c || (c.dir === 'in' && !c.answered)) return;
    try {
      await invite(c, handle);
    } catch (e) {
      if (call === c) note(c, `could not add ${handle}: ${e.message}`);
    }
  }

  // ---------- incoming ----------
  function onInvite(env, from, m) {
    if (env.from === me()) return;
    if (inviteExpired(env.ts)) return log(env.from, `Missed ${word(m.video)} call`);
    const c = call;
    if (c) {
      if (c.id === m.id) return;
      const crossing = c.dir === 'out' && c.members.size === 1 && c.invites.size === 1 && c.invites.has(env.from);
      if (crossing && glareYield(c.id, m.id)) {
        signalFor(c, c.invites.get(env.from).targets, 'hangup', { reason: 'cancelled' }); // theirs wins: ring for it instead
        end(c, null);
      } else if (crossing) {
        return; // ours wins; they cancel theirs and ring for ours
      } else {
        return signalFor({ id: m.id }, [from], 'busy');
      }
    }
    const n = call = newCall({ id: m.id, peer: env.from, from, dir: 'in', video: m.video, state: 'ringing', invite: m });
    n.timer = setTimeout(() => end(n, `Missed ${word(m.video)} call`), Math.max(5000, CALL_RING_MS - (Date.now() - env.ts)));
    render();
  }

  async function accept(withVideo) {
    const c = call;
    if (!c || c.dir !== 'in' || c.state !== 'ringing') return;
    clearTimeout(c.timer);
    c.state = 'connecting';
    render();
    const m = c.invite;
    try {
      await setupLocal(c, withVideo && m.video);
      if (call !== c) return;
      if (m.sfu) {
        // a large call: join its SFU room, nothing to link directly
        if (!c.canSfu) throw new Error('this browser or relay cannot join large calls');
        c.members.add(c.from);
        c.seen.add(c.peer);
        learnKey(c, c.from, m);
        await joinSfu(c, m.sfu);
        if (call !== c) return;
        if (!c.sfu) throw new Error('could not reach the call');
        await send(c.from, { kind: 'call', op: 'answer', id: c.id, sfu: m.sfu, ...keyFields(c) });
        c.answered = true;
        feature();
        render();
        return;
      }
      const L = newLink(c.from);
      c.links.set(c.from, L);
      c.members.add(c.from);
      c.seen.add(c.peer);
      takeKey(c, L, m);
      const sdp = await makeAnswer(c, L, m.sdp);
      if (call !== c) return;
      await send(c.from, { kind: 'call', op: 'answer', id: c.id, sdp, ...keyFields(c) });
      c.answered = true;
      // offers from other members may have come in while we were answering
      for (const [a, st] of c.stash) if (c.members.has(a)) { c.stash.delete(a); onOffer(c, a, st); }
      feature();
      render();
    } catch (e) {
      console.warn('answer failed', e);
      signalFor(c, [c.from], 'hangup', { reason: 'failed' });
      end(c, `Call failed: ${e.message}`);
    }
  }

  function decline() {
    const c = call;
    if (!c || c.dir !== 'in' || c.state !== 'ringing') return;
    signalFor(c, [c.from], 'reject');
    end(c, `Declined ${word(c.video)} call`);
  }

  // ---------- both ----------
  function summary(c) {
    if (!c.startedAt) return null;
    const group = c.seen.size > 1;
    return `${group ? `Group ${word(c.video)}` : Word(c.video)} call · ${formatDuration(Date.now() - c.startedAt)}`
      + (group ? ` · with ${[...c.seen].join(', ')}` : '');
  }

  function hangup() {
    const c = call;
    if (!c) return;
    if (c.dir === 'in' && c.state === 'ringing') return decline();
    for (const inv of c.invites.values()) signalFor(c, inv.targets, 'hangup', { reason: 'cancelled' });
    const rest = others(c);
    signalFor(c, rest, 'hangup', { reason: 'ended' });
    if (!c.startedAt && !rest.length) return end(c, `Cancelled ${word(c.video)} call`);
    end(c, summary(c) || `${Word(c.video)} call`);
  }

  function onHangup(c, from, m) {
    if (c.dir === 'in' && !c.answered) {
      if (from !== c.from) return;
      const text = {
        'answered-elsewhere': `${Word(c.video)} call answered on another device`,
        declined: `${Word(c.video)} call declined on another device`,
      }[m.reason] || `Missed ${word(c.video)} call`;
      return end(c, text);
    }
    if (c.members.has(from)) dropMember(c, from, m.reason);
  }

  function end(c, text) {
    if (call !== c) return;
    call = null;
    for (const t of [c.timer, c.switchTimer, c.noteTimer]) clearTimeout(t);
    clearInterval(c.tick);
    clearInterval(c.rotateTimer);
    for (const inv of c.invites.values()) { clearTimeout(inv.timer); closeLink(c, inv.link); }
    for (const L of c.links.values()) closeLink(c, L);
    leaveSfu(c);
    for (const f of c.cleanup) { try { f(); } catch { /* best effort */ } }
    c.worker?.terminate();
    render();
    if (text) log(c.peer, text);
  }

  async function onSignal(env, payload) {
    let m;
    try { m = parseCallSignal(payload); } catch (e) { console.warn('ignored call signal:', e.message); return; }
    const from = deviceAddr(env.from, env.fromDevice);
    if (m.op === 'invite') return onInvite(env, from, m);
    const c = call;
    if (!c || c.id !== m.id) return;
    const invOf = () => [...c.invites.values()].find((i) => i.targets.includes(from));
    switch (m.op) {
      case 'answer': {
        const inv = invOf();
        if (inv) return onAnswer(c, from, m, inv);
        return;
      }
      case 'reject':
      case 'busy': {
        const inv = invOf();
        if (!inv) return;
        signalFor(c, inv.targets.filter((a) => a !== from), 'hangup', { reason: 'declined' });
        const busy = m.op === 'busy';
        return inviteGone(c, inv, busy ? `${inv.handle} is busy` : `${inv.handle} declined`,
          busy ? `${inv.handle} is busy` : `${inv.handle} declined the ${word(c.video)} call`);
      }
      case 'hangup': return onHangup(c, from, m);
      case 'roster': return onRoster(c, from, m);
      case 'offer': return onOffer(c, from, m);
      case 'accept': return onAccept(c, from, m);
      case 'key':
        // kept even from someone not announced yet: in a large call keys can beat the roster
        return learnKey(c, from, m);
      case 'media': {
        if (!c.members.has(from)) return;
        if (m.screen) c.screens.add(from); else c.screens.delete(from);
        render();
      }
    }
  }

  // ---------- camera and screen ----------
  async function pushVideo(c) {
    const t = videoTrack(c);
    const links = [...c.links.values(), ...[...c.invites.values()].map((i) => i.link)];
    const senders = links.filter(Boolean).map((L) => L.videoTx?.sender);
    if (c.sfu?.videoTx) senders.push(c.sfu.videoTx.sender);
    await Promise.all(senders.map((s) => s?.replaceTrack(t).catch((e) => console.warn('replaceTrack', e))));
    render();
  }

  async function toggleCam() {
    const c = call;
    if (!c || (c.dir === 'in' && !c.answered)) return;
    if (c.cam) {
      const cam = c.cam;
      c.cam = null;
      await pushVideo(c);
      cam.stop();
    } else {
      const cam = await getCam();
      if (call !== c) return cam.stop();
      c.cam = cam;
      await pushVideo(c);
    }
  }

  async function toggleScreen() {
    const c = call;
    if (!c || (c.dir === 'in' && !c.answered)) return;
    if (c.screen) return stopScreen(c);
    let s;
    try { s = await getScreen(); } catch { return note(c, 'screen sharing cancelled'); }
    if (call !== c) return s.stop();
    c.screen = s;
    s.track.onended = () => { if (call === c && c.screen === s) stopScreen(c); };
    await pushVideo(c);
    signalFor(c, others(c), 'media', { screen: true });
  }

  async function stopScreen(c) {
    const s = c.screen;
    c.screen = null;
    await pushVideo(c);
    s?.stop();
    signalFor(c, others(c), 'media', { screen: false });
  }

  // ---------- UI ----------
  const initials = (h) => (h || '?').replace(/^@/, '').slice(0, 2).toUpperCase();
  const hasVideo = (L) => L.video.getVideoTracks().some((t) => !t.muted && t.readyState === 'live');
  const sources = (c) => others(c)
    .map((a) => c.sfu?.peers.get(a) || (c.links.get(a)?.addr ? c.links.get(a) : null))
    .filter(Boolean);

  function tile(L) {
    if (L.el) return L.el;
    const el = document.createElement('div');
    el.className = 'tile';
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = true; // sound comes from the audio element
    v.srcObject = L.video;
    const a = document.createElement('audio');
    a.autoplay = true;
    a.srcObject = L.audio;
    const avatar = document.createElement('div');
    avatar.className = 'tile-avatar';
    const name = document.createElement('div');
    name.className = 'tile-name';
    el.append(v, avatar, a, name);
    Object.assign(L, { el, avatarEl: avatar, nameEl: name });
    return el;
  }

  function render() {
    const box = $('call');
    const c = call;
    if (!c) {
      box.classList.add('hidden');
      $('call-grid').replaceChildren();
      $('local-video').srcObject = null;
      $('call-add').classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const ringingIn = c.dir === 'in' && c.state === 'ringing';
    const inCall = !(c.dir === 'in' && !c.answered);
    box.classList.toggle('incoming', ringingIn);

    // one tile per other member, from the SFU or from our mesh link
    const shown = sources(c);
    const grid = $('call-grid');
    const els = shown.map((L) => {
      const el = tile(L);
      const screen = c.screens.has(L.addr);
      const off = L.sfu && c.sfu?.shown && !c.sfu.shown.has(L.addr); // not in my view right now
      el.classList.toggle('has-video', hasVideo(L) && !off);
      el.classList.toggle('presenting', screen);
      el.classList.toggle('speaking', Boolean(L.speaking));
      L.avatarEl.textContent = initials(L.handle);
      const st = c.stats?.peers?.[L.tag];
      L.nameEl.textContent = `${L.handle}${screen ? ' · presenting' : ''}${L.state !== 'active' ? ` · ${L.state}…` : ''}`
        + (L.e2ee && st ? ` · 🔒 ${st.dec}` : '');
      return el;
    });
    // presenters first, then whoever spoke last (the SFU's view order)
    if (c.sfu?.shown) {
      const rank = (L) => (c.screens.has(L.addr) ? 0 : c.sfu.shown.has(L.addr) ? 1 : 2);
      const order = shown.map((L, i) => [rank(L), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => els[i]);
      els.splice(0, els.length, ...order);
    }
    els.forEach((el, i) => { if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null); });
    for (const el of [...grid.children]) if (!els.includes(el)) el.remove();
    grid.dataset.n = String(els.length);
    grid.classList.toggle('many', els.length > 9);
    box.classList.toggle('via-sfu', Boolean(c.sfu));
    box.classList.toggle('has-video', shown.some(hasVideo));
    box.classList.toggle('has-tiles', shown.length > 0);

    const names = [...new Set(others(c).map(handleOf))];
    $('call-peer').textContent = names.length ? names.join(', ') : c.peer;
    let status = {
      starting: 'Starting…',
      ringing: c.dir === 'out' ? 'Ringing…' : `Incoming ${word(c.video)} call`,
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      active: c.startedAt ? formatDuration(Date.now() - c.startedAt) : 'Connected',
    }[c.state] || '';
    const ringing = [...c.invites.keys()].filter((h) => !(c.state === 'ringing' && names.length === 0 && h === c.peer));
    if (ringing.length) status += ` · ringing ${ringing.join(', ')}`;
    if (c.note) status += ` · ${c.note}`;
    $('call-status').textContent = status;

    let sec;
    if (ringingIn) sec = c.invite.e2ee && mode ? '🔒 End-to-end encrypted call' : '🔒 Encrypted call';
    else if (!shown.length) sec = c.worker ? '🔒 End-to-end encrypted call' : '🔒 Encrypted call';
    else if (c.worker && shown.every((L) => L.e2ee)) {
      let dec = 0; let fail = 0;
      for (const L of shown) { const st = c.stats?.peers?.[L.tag]; dec += st?.dec || 0; fail += st?.fail || 0; }
      sec = `🔒 Frames encrypted end to end${c.stats ? ` · sent ${c.stats.enc} · received ${dec}${fail ? ` · ${fail} dropped` : ''}` : ''}`
        + (c.rotations ? ` · key rotated ${c.rotations}×` : '')
        + (c.sfu ? ' · large call: the relay forwards frames it can’t read' : '');
    } else {
      sec = '🔒 DTLS-SRTP, keys checked through your encrypted chat';
    }
    if (c.mic?.test || c.cam?.test || c.screen?.test) sec += ' · sending a test signal (no camera or microphone)';
    $('call-e2ee').textContent = sec;

    const mine = videoTrack(c);
    const preview = $('local-video');
    if (preview.srcObject?.getVideoTracks()[0] !== mine) preview.srcObject = mine ? new MediaStream([mine]) : null;
    preview.classList.toggle('hidden', !mine);

    $('call-accept-video').classList.toggle('hidden', !ringingIn || !c.video);
    $('call-accept-voice').classList.toggle('hidden', !ringingIn);
    $('call-decline').classList.toggle('hidden', !ringingIn);
    for (const id of ['call-mute', 'call-cam', 'call-add-open']) $(id).classList.toggle('hidden', !inCall || !c.mic);
    $('call-screen').classList.toggle('hidden', !inCall || !c.mic || !canShareScreen());
    $('call-end').classList.toggle('hidden', ringingIn);
    $('call-mute').textContent = c.mic?.track && !c.mic.track.enabled ? 'Unmute' : 'Mute';
    $('call-cam').textContent = c.cam ? 'Camera off' : 'Camera on';
    $('call-screen').textContent = c.screen ? 'Stop sharing' : 'Share screen';
    if (!inCall) $('call-add').classList.add('hidden');
  }

  function openAdd() {
    const c = call;
    if (!c) return;
    const inCall = new Set([...[...c.members].map(handleOf), ...c.invites.keys(), me()]);
    const sel = $('call-add-who');
    sel.replaceChildren();
    for (const h of contacts().filter((x) => !inCall.has(x))) {
      const o = document.createElement('option');
      o.value = h; o.textContent = h;
      sel.append(o);
    }
    $('call-add-none').classList.toggle('hidden', sel.options.length > 0);
    $('call-add-go').disabled = sel.options.length === 0;
    $('call-add').classList.remove('hidden');
  }

  $('call-accept-video').onclick = () => accept(true);
  $('call-accept-voice').onclick = () => accept(false);
  $('call-decline').onclick = decline;
  $('call-end').onclick = hangup;
  $('call-mute').onclick = () => { if (call?.mic?.track) { call.mic.track.enabled = !call.mic.track.enabled; render(); } };
  $('call-cam').onclick = () => toggleCam().catch((e) => console.warn('camera', e));
  $('call-screen').onclick = () => toggleScreen().catch((e) => console.warn('screen', e));
  $('call-add-open').onclick = openAdd;
  $('call-add-cancel').onclick = () => $('call-add').classList.add('hidden');
  $('call-add-go').onclick = () => {
    const h = $('call-add-who').value;
    $('call-add').classList.add('hidden');
    if (h) add(h);
  };
  addEventListener('pagehide', () => { if (call) hangup(); });
  if (MEDIA_TEST) globalThis.__fabricCall = () => call; // inspection in test mode only

  return {
    start,
    add,
    onSignal,
    hangup,
    toggleCam,
    toggleScreen,
    onRelay,
    reconnected,
    get active() {
      const c = call;
      if (!c) return null;
      const shown = sources(c);
      return {
        id: c.id, peer: c.peer, dir: c.dir, state: c.state, kid: c.kid, rotations: c.rotations,
        members: [...c.members], invites: [...c.invites.keys()], screen: Boolean(c.screen),
        e2ee: Boolean(c.worker) && shown.length > 0 && shown.every((L) => L.e2ee),
        sent: c.stats?.enc || 0,
        sfu: c.sfu ? { room: c.sfu.room, state: c.sfu.pc?.connectionState || 'joining', view: [...(c.sfu.shown || [])] } : null,
        links: shown.map((L) => ({
          addr: L.addr, via: L.sfu ? 'sfu' : 'mesh', state: L.state, e2ee: L.e2ee, screen: c.screens.has(L.addr), video: hasVideo(L),
          dec: c.stats?.peers?.[L.tag]?.dec || 0, fail: c.stats?.peers?.[L.tag]?.fail || 0,
        })),
      };
    },
    mode,
  };
}
