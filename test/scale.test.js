// Calls at scale: operator TURN logins, simulcast layer forwarding, and rooms spread over
// several SFU nodes (linked in process, then as real node processes behind the relay's cluster).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, useOPUS, useVP8 } from 'werift';
import { createSfu, encodeLinkRtp, decodeLinkRtp } from '../server/sfu.js';
import { parseVp8, pickLayer, qualityFor, createLayerForwarder } from '../server/simulcast.js';
import { turnFromEnv, turnCredentials, checkTurnLogin } from '../server/turn.js';
import { nodeToken, checkNodeToken } from '../server/sfu-link.js';
import { createSfuNode } from '../server/sfu-node.js';
import { createSfuCluster, clusterFromEnv } from '../server/sfu-cluster.js';

const ROOM = 'room_' + 'y'.repeat(20);
const SECRET = 'node-secret-for-tests-only';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}
const quiet = () => {};

// ---------- TURN ----------
test('turn: short-lived logins coturn accepts, nothing about who asked', () => {
  assert.equal(turnFromEnv({}), null);
  assert.throws(() => turnFromEnv({ FABRIC_TURN_URLS: 'turn:t.example.com:3478' }), /SECRET/);
  assert.throws(() => turnFromEnv({ FABRIC_TURN_URLS: 'http://x', FABRIC_TURN_SECRET: 'x'.repeat(32) }));
  const cfg = turnFromEnv({ FABRIC_TURN_URLS: 'turn:t.example.com:3478?transport=udp, turns:t.example.com:443?transport=tcp', FABRIC_TURN_SECRET: 's'.repeat(32), FABRIC_TURN_TTL: '600' });
  assert.equal(cfg.urls.length, 2);
  const now = 1_800_000_000_000;
  const c = turnCredentials(cfg, now);
  const [exp, id] = c.username.split(':');
  assert.equal(Number(exp), now / 1000 + 600);
  assert.match(id, /^[A-Za-z0-9_-]{12}$/, 'a random id, not a handle');
  // the coturn use-auth-secret rule: base64(HMAC-SHA1(secret, username))
  assert.equal(c.credential, createHmac('sha1', 's'.repeat(32)).update(c.username).digest('base64'));
  assert.ok(checkTurnLogin(cfg.secret, c.username, c.credential, now));
  assert.ok(!checkTurnLogin(cfg.secret, c.username, c.credential, now + 601_000), 'expired');
  assert.ok(!checkTurnLogin('another secret that is long', c.username, c.credential, now));
  assert.notEqual(turnCredentials(cfg, now).username, c.username, 'every login is new');
});

// ---------- simulcast ----------
function vp8(pid, key) {
  // X=1 S=1 partition 0 | I=1 | 15-bit picture id | frame header byte (P bit) | "encrypted" rest
  return Buffer.from([0x90, 0x80, 0x80 | (pid >> 8), pid & 0xff, key ? 0x10 : 0x11, 0xaa, 0xbb]);
}

test('simulcast: VP8 descriptor, layer choice, quality by layout', () => {
  const d = parseVp8(vp8(0x1234, true));
  assert.equal(d.start, true);
  assert.equal(d.keyframe, true);
  assert.equal(d.pid, 0x1234);
  assert.equal(d.pidBits, 15);
  assert.equal(parseVp8(vp8(7, false)).keyframe, false);
  assert.equal(parseVp8(Buffer.from([0x10, 0x10])).keyframe, true, 'no extensions, keyframe');
  assert.equal(parseVp8(Buffer.from([0x00, 0x10])).keyframe, false, 'not the start of a frame');
  assert.equal(parseVp8(Buffer.from([0x90, 0x80])), null, 'truncated');

  assert.equal(pickLayer([], 'h'), null);
  assert.equal(pickLayer(['l', 'm', 'h'], 'm'), 'm');
  assert.equal(pickLayer(['l', 'm'], 'h'), 'm', 'top layer not sent: next best');
  assert.equal(pickLayer(['m', 'h'], 'l'), 'm', 'nothing small enough: the smallest');
  assert.equal(pickLayer([''], 'l'), '', 'a sender without simulcast');

  assert.deepEqual([0, 1].map((i) => qualityFor(i, 2)), ['h', 'h']);
  assert.deepEqual([0, 1, 3].map((i) => qualityFor(i, 4)), ['h', 'm', 'm']);
  assert.deepEqual([0, 1, 8].map((i) => qualityFor(i, 9)), ['h', 'l', 'l']);
});

test('simulcast: a viewer switches layer only at a keyframe, with one continuous picture id', () => {
  const f = createLayerForwarder();
  assert.equal(f.target('l'), true);
  const pidOf = (r) => parseVp8(r.payload).pid;
  let r = f.packet('l', vp8(100, false));
  assert.equal(r.switched, true, 'the first packet starts the stream');
  assert.equal(pidOf(r), 100);
  assert.equal(f.packet('h', vp8(5000, true)), null, 'other layers are dropped');

  assert.equal(f.target('h'), true, 'asks for a keyframe on h');
  assert.equal(f.pending, 'h');
  assert.equal(f.packet('h', vp8(5000, false)), null, 'no switch on a delta frame');
  r = f.packet('l', vp8(101, false));
  assert.equal(pidOf(r), 101, 'l keeps flowing until then');
  r = f.packet('h', vp8(5001, true));
  assert.equal(r.switched, true);
  assert.equal(f.current, 'h');
  assert.equal(pidOf(r), 102, 'picture ids continue from l');
  assert.equal(pidOf(f.packet('h', vp8(5002, false))), 103);
  assert.equal(f.packet('l', vp8(102, false)), null);
  // the payload after the descriptor is untouched (it's the encrypted frame)
  assert.deepEqual([...f.packet('h', vp8(5003, false)).payload.subarray(4)], [0x11, 0xaa, 0xbb]);
  // a layer that stopped arriving is replaced at once
  assert.equal(f.target('m', { immediate: true }), true);
  assert.equal(f.current, 'm');
  assert.equal(pidOf(f.packet('m', vp8(9, false))), 105);
});

test('sfu link: RTP framing between nodes', () => {
  const rtp = Buffer.alloc(20, 7);
  const b = encodeLinkRtp('@ana_x.veil#dev1abcd', 'video', 'm', rtp);
  assert.deepEqual(decodeLinkRtp(b), { addr: '@ana_x.veil#dev1abcd', kind: 'video', rid: 'm', rtp: b.subarray(b.length - 20) });
  assert.equal(decodeLinkRtp(encodeLinkRtp('not an address', 'audio', '', rtp)), null);
  assert.equal(decodeLinkRtp(Buffer.alloc(5)), null);
  const t = nodeToken(SECRET, 'link', ROOM);
  assert.ok(checkNodeToken(SECRET, t, 'link', ROOM));
  assert.ok(!checkNodeToken(SECRET, t, 'link', 'room_' + 'z'.repeat(20)), 'bound to its room');
  assert.ok(!checkNodeToken(SECRET, t, 'ctl'), 'bound to its purpose');
  assert.ok(!checkNodeToken('another secret, long enough', t, 'link', ROOM));
  assert.ok(!checkNodeToken(SECRET, t, 'link', ROOM, Date.now() + 120_000), 'expires');
});

// ---------- werift clients (not browsers; no simulcast, so they send rid '') ----------
function client(addr, svc) {
  const cfg = { codecs: { audio: [useOPUS()], video: [useVP8()] } };
  const pc = new RTCPeerConnection(cfg);
  const up = new RTCPeerConnection(cfg);
  const c = { addr, pc, up, got: new Map(), members: [], streams: {}, closed: null };
  c.audio = new MediaStreamTrack({ kind: 'audio' });
  c.video = new MediaStreamTrack({ kind: 'video' });
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe(() => {
      const mid = pc.getTransceivers().find((t) => t.receiver.track === track || t.receiver.tracks?.includes(track))?.mid;
      const s = c.streams[mid];
      if (!s) return;
      const key = `${s.addr}/${s.kind}`;
      c.got.set(key, (c.got.get(key) || 0) + 1);
    });
  });
  c.onMessage = async (msg) => {
    if (msg.type === 'sfu_members') c.members = msg.members;
    if (msg.type === 'sfu_closed') c.closed = msg.reason;
    if (msg.type !== 'sfu_offer') return;
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    c.streams = msg.streams;
    await pc.setLocalDescription(await pc.createAnswer());
    await svc.ws(addr, { type: 'sfu_answer', room: msg.room, sdp: pc.localDescription.sdp });
  };
  c.join = async (room = ROOM) => {
    const j = await svc.ws(addr, { type: 'sfu_join', room });
    if (typeof j === 'string') return j;
    up.addTransceiver(c.audio, { direction: 'sendonly' });
    up.addTransceiver(c.video, { direction: 'sendonly' });
    await up.setLocalDescription(await up.createOffer());
    const r = await svc.ws(addr, { type: 'sfu_publish', room, sdp: up.localDescription.sdp });
    if (typeof r === 'string') return r;
    await up.setRemoteDescription({ type: 'answer', sdp: r.sdp });
    return null;
  };
  let seq = 1;
  c.pump = setInterval(() => {
    for (const [track, pt] of [[c.audio, 111], [c.video, 96]]) {
      const header = new RtpHeader({ payloadType: pt, sequenceNumber: seq & 0xffff, timestamp: seq * 960, marker: true });
      track.writeRtp(new RtpPacket(header, Buffer.from(`encrypted frame from ${addr} #${seq}`)));
    }
    seq++;
  }, 20);
  c.stop = () => { clearInterval(c.pump); pc.close(); up.close(); };
  return c;
}

const deliver = (clients) => (addr, msg) => {
  const c = clients.get(addr);
  if (c) queueMicrotask(() => c.onMessage(msg).catch((e) => console.error(addr, e)));
};

test('two SFU nodes linked in process: members on each see and hear each other', { timeout: 40_000 }, async () => {
  const clients = new Map();
  const A = createSfu({ send: deliver(clients) });
  const B = createSfu({ send: deliver(clients) });
  const ana = client('@ana_x.veil#dev1abcd', A);
  const ben = client('@ben_x.veil#dev1abcd', B);
  const sam = client('@sam_x.veil#dev1abcd', B);
  for (const c of [ana, ben, sam]) clients.set(c.addr, c);
  try {
    // a link is two transports; JSON and binary cross as they would over a WebSocket
    let hA;
    let hB;
    const pipe = (to) => ({
      send: (o) => queueMicrotask(() => to().onMessage(JSON.parse(JSON.stringify(o)))),
      sendBinary: (b) => { const copy = Buffer.from(b); queueMicrotask(() => to().onBinary(copy)); },
      close: () => queueMicrotask(() => to().onClose()),
    });
    hA = A.attachLink(ROOM, pipe(() => hB), { peer: 'B' });
    hB = B.attachLink(ROOM, pipe(() => hA), { peer: 'A' });

    assert.equal(await ana.join(), null);
    assert.equal(await ben.join(), null);
    assert.equal(await sam.join(), null);
    await until(() => ana.got.get(`${ben.addr}/video`) > 5 && ana.got.get(`${sam.addr}/audio`) > 5, 15_000, 'ana (A) gets B members');
    await until(() => ben.got.get(`${ana.addr}/video`) > 5 && sam.got.get(`${ana.addr}/audio`) > 5, 15_000, 'B members get ana');
    await until(() => ben.got.get(`${sam.addr}/video`) > 5, 15_000, 'B members see each other locally');
    assert.deepEqual(new Set(ana.members), new Set([ana.addr, ben.addr, sam.addr]));
    assert.equal(A.layersOf(ana.addr)[ben.addr], '', 'werift senders have one layer');

    // ana only shows sam: A stops asking B for ben's video
    await A.ws(ana.addr, { type: 'sfu_view', room: ROOM, videos: [sam.addr] });
    await wait(800);
    const v0 = ana.got.get(`${ben.addr}/video`);
    const a0 = ana.got.get(`${ben.addr}/audio`);
    await wait(700);
    assert.ok(ana.got.get(`${ben.addr}/video`) - v0 <= 3, 'ben video no longer crosses the link');
    assert.ok(ana.got.get(`${ben.addr}/audio`) - a0 > 10, 'audio always does');

    // sam leaves B: A hears about it over the link
    await B.ws(sam.addr, { type: 'sfu_leave', room: ROOM });
    await until(() => ana.members.length === 2, 5000, 'roster over the link');
    // the link closes: each side forgets the other's members
    hA.link.close();
    await until(() => ana.members.length === 1 && ben.members.length === 1, 5000, 'link down');
  } finally {
    for (const c of clients.values()) c.stop();
    A.close();
    B.close();
  }
});

test('sfu cluster: separate node processes, a room spilling onto a second node', { timeout: 60_000 }, async () => {
  assert.equal(clusterFromEnv({}), null);
  assert.throws(() => clusterFromEnv({ FABRIC_SFU_NODES: 'ws://n1:8800' }), /SECRET/);
  assert.throws(() => clusterFromEnv({ FABRIC_SFU_NODES: 'http://n1', FABRIC_SFU_NODE_SECRET: SECRET }), /origin/);

  const n1 = await createSfuNode({ port: 0, host: '127.0.0.1', secret: SECRET, log: quiet });
  const n2 = await createSfuNode({ port: 0, host: '127.0.0.1', secret: SECRET, log: quiet });
  const clients = new Map();
  const urls = [`ws://127.0.0.1:${n1.port}`, `ws://127.0.0.1:${n2.port}`];
  const cluster = createSfuCluster({ urls, secret: SECRET, cap: 1, send: deliver(clients), log: quiet });
  const ana = client('@ana_x.veil#dev1abcd', cluster);
  const ben = client('@ben_x.veil#dev1abcd', cluster);
  for (const c of [ana, ben]) clients.set(c.addr, c);
  try {
    // nodes refuse anyone without a token from the shared secret
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket(`${urls[0]}/ctl?token=${nodeToken('a different secret!!', 'ctl')}`);
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
    });
    assert.ok(refused, 'wrong secret refused');
    await until(() => cluster.stats().nodes.every((n) => n.up), 5000, 'cluster connects');

    assert.equal(await ana.join(), null);
    assert.equal(await ben.join(), null);
    assert.notEqual(cluster.nodeOf(ana.addr), cluster.nodeOf(ben.addr), 'cap 1: the room spilled onto the second node');
    await until(() => ana.got.get(`${ben.addr}/video`) > 5 && ben.got.get(`${ana.addr}/audio`) > 5, 20_000, 'media across nodes');
    assert.deepEqual(new Set(ben.members), new Set([ana.addr, ben.addr]));
    assert.equal(cluster.stats().members, 2);

    // a node going away closes its members' calls (their clients rejoin elsewhere)
    const lost = cluster.nodeOf(ben.addr) === urls[0] ? n1 : n2;
    await lost.close();
    await until(() => ben.closed === 'media node lost', 5000, 'ben told');
    await until(() => ana.members.length === 1, 5000, 'ana sees ben gone');
    assert.equal(cluster.nodeOf(ben.addr), null);
  } finally {
    for (const c of clients.values()) c.stop();
    cluster.close();
    await n1.close();
    await n2.close();
  }
});
