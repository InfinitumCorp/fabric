// The SFU forwards each member's (already encrypted) RTP to everyone else in the room, and
// renegotiates when people come and go. Clients here are werift peers, not browsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, useOPUS, useVP8 } from 'werift';
import { createSfu, MAX_VIEW } from '../server/sfu.js';

const ROOM = 'room_' + 'x'.repeat(20);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}

function client(addr, sfu) {
  const cfg = { codecs: { audio: [useOPUS()], video: [useVP8()] } };
  const pc = new RTCPeerConnection(cfg);   // download: the relay offers
  const up = new RTCPeerConnection(cfg);   // upload: this client offers, once
  const c = { addr, pc, up, got: new Map(), members: [], streams: {}, closed: null };
  c.audio = new MediaStreamTrack({ kind: 'audio' });
  c.video = new MediaStreamTrack({ kind: 'video' });
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      const mid = pc.getTransceivers().find((t) => t.receiver.track === track || t.receiver.tracks?.includes(track))?.mid;
      const s = c.streams[mid];
      if (!s) return;
      const key = `${s.addr}/${s.kind}`;
      c.got.set(key, (c.got.get(key) || 0) + 1);
      c.last = rtp;
    });
  });
  c.onMessage = async (msg) => {
    if (msg.type === 'sfu_members') c.members = msg.members;
    if (msg.type === 'sfu_closed') c.closed = msg.reason;
    if (msg.type !== 'sfu_offer') return;
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    c.streams = msg.streams;
    await pc.setLocalDescription(await pc.createAnswer());
    await sfu.ws(addr, { type: 'sfu_answer', room: msg.room, sdp: pc.localDescription.sdp });
  };
  c.join = async (room = ROOM) => {
    const j = await sfu.ws(addr, { type: 'sfu_join', room });
    if (typeof j === 'string') return j;
    up.addTransceiver(c.audio, { direction: 'sendonly' });
    up.addTransceiver(c.video, { direction: 'sendonly' });
    await up.setLocalDescription(await up.createOffer());
    const r = await sfu.ws(addr, { type: 'sfu_publish', room, sdp: up.localDescription.sdp });
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

function harness() {
  const clients = new Map();
  const sfu = createSfu({
    send: (addr, msg) => { const c = clients.get(addr); if (c) queueMicrotask(() => c.onMessage(msg).catch((e) => console.error(addr, e))); },
  });
  return {
    sfu,
    add(addr) { const c = client(addr, sfu); clients.set(addr, c); return c; },
    stopAll() { for (const c of clients.values()) c.stop(); sfu.close(); },
  };
}

test('sfu: every member receives every other member, renegotiates on join and leave', { timeout: 40_000 }, async () => {
  const h = harness();
  try {
    const a = h.add('@ana#d1');
    const b = h.add('@ben#d1');
    assert.equal(await a.join(), null);
    assert.equal(await b.join(), null);
    await until(() => a.got.get('@ben#d1/audio') > 5 && a.got.get('@ben#d1/video') > 5, 10_000, 'ana hears ben');
    await until(() => b.got.get('@ana#d1/audio') > 5 && b.got.get('@ana#d1/video') > 5, 10_000, 'ben hears ana');
    // payloads pass through untouched (they are E2EE frames the relay can't read)
    assert.match(a.last.payload.toString(), /^encrypted frame from @ben#d1/);
    assert.equal(a.last.header.extensions.length, 0);

    const s = h.add('@sam#d1');
    assert.equal(await s.join(), null);
    await until(() => s.got.get('@ana#d1/video') > 5 && s.got.get('@ben#d1/video') > 5, 10_000, 'sam sees both');
    await until(() => a.got.get('@sam#d1/audio') > 5 && b.got.get('@sam#d1/audio') > 5, 10_000, 'both hear sam');
    assert.deepEqual(new Set(a.members), new Set(['@ana#d1', '@ben#d1', '@sam#d1']));
    assert.deepEqual(h.sfu.stats(), { rooms: 1, members: 3 });

    // ben leaves: the others renegotiate, his slot is freed and reused by the next newcomer
    await h.sfu.ws(b.addr, { type: 'sfu_leave', room: ROOM });
    await until(() => a.members.length === 2, 5000, 'roster update');
    const before = Object.keys(a.streams).length;
    await until(() => !Object.values(a.streams).some((x) => x.addr === '@ben#d1'), 5000, 'ben removed from offer');
    const z = h.add('@zoe#d1');
    assert.equal(await z.join(), null);
    await until(() => a.got.get('@zoe#d1/video') > 5, 10_000, 'ana sees zoe');
    assert.equal(Object.keys(a.streams).length, before, 'freed transceivers are reused');

    // speaker focus: sam only wants zoe's video now; ana's video stops, her audio doesn't
    await h.sfu.ws(s.addr, { type: 'sfu_view', room: ROOM, videos: ['@zoe#d1'] });
    await wait(300);
    const v0 = s.got.get('@ana#d1/video');
    const a0 = s.got.get('@ana#d1/audio');
    await wait(600);
    assert.ok(s.got.get('@ana#d1/video') - v0 <= 2, 'ana video no longer forwarded to sam');
    assert.ok(s.got.get('@ana#d1/audio') - a0 > 10, 'ana audio still forwarded');
  } finally {
    h.stopAll();
  }
});

test('sfu: input checks and limits', async () => {
  const sent = [];
  const sfu = createSfu({ send: (a, m) => sent.push([a, m]), maxRoom: 2 });
  try {
    assert.equal(await sfu.ws('@a#d1', { type: 'sfu_join', room: 'short' }), 'bad room');
    assert.equal((await sfu.ws('@a#d1', { type: 'sfu_join', room: ROOM })).type, 'sfu_joined');
    assert.equal((await sfu.ws('@b#d1', { type: 'sfu_join', room: ROOM })).type, 'sfu_joined');
    assert.equal(await sfu.ws('@c#d1', { type: 'sfu_publish', room: ROOM, sdp: 'v=0' }), 'join first');
    assert.equal(await sfu.ws('@b#d1', { type: 'sfu_publish', room: ROOM, sdp: 'garbage' }), 'bad sdp');
    assert.equal(await sfu.ws('@c#d1', { type: 'sfu_join', room: ROOM }), 'room full');
    assert.equal(await sfu.ws('@a#d1', { type: 'nope' }), 'unknown type');
    // a bad answer removes the member instead of breaking the room
    await sfu.ws('@a#d1', { type: 'sfu_answer', room: ROOM, sdp: 'garbage' });
    assert.ok(sent.some(([a, m]) => a === '@a#d1' && m.type === 'sfu_closed'));
    assert.deepEqual(sfu.stats(), { rooms: 1, members: 1 });
    sfu.gone('@b#d1');
    assert.deepEqual(sfu.stats(), { rooms: 0, members: 0 });
    assert.equal(MAX_VIEW, 9);
  } finally {
    sfu.close();
  }
});

// ---------- through the relay's WebSocket ----------
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { signDeviceList, newDeviceId } from '../shared/devices.js';
import { parseCallSignal, mergeRoster, preferRoom, MAX_SFU_DEVICES } from '../shared/callproto.js';

async function device(port, handle) {
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle, version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: 'test', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
  const next = (pred) => until(() => inbox.some(pred), 5000, 'relay message').then(() => inbox.splice(inbox.findIndex(pred), 1)[0]);
  const hello = await next((m) => m.type === 'hello');
  ws.send(JSON.stringify({ type: 'register', handle, deviceId: dev.id, list, proof: await ownershipProof(dev.keys.dh.privateJwk, hello.relayKey, hello.nonce) }));
  assert.equal((await next((m) => m.type === 'registered' || m.type === 'error')).type, 'registered');
  return { addr: `${handle}#${dev.id}`, ws, next, send: (o) => ws.send(JSON.stringify(o)) };
}

test('relay: sfu_* messages reach the SFU; a closed socket leaves the room', { timeout: 20_000 }, async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {} });
  t.after(() => relay.close());
  const a = await device(relay.port, '@ana.veil');
  const b = await device(relay.port, '@ben.veil');
  a.send({ type: 'sfu_join', room: ROOM, ref: 'j1' });
  assert.equal((await a.next((m) => m.ref === 'j1')).type, 'sfu_joined');
  b.send({ type: 'sfu_join', room: ROOM, ref: 'j2' });
  await b.next((m) => m.ref === 'j2');
  const mem = await a.next((m) => m.type === 'sfu_members' && m.members.length === 2);
  assert.deepEqual(new Set(mem.members), new Set([a.addr, b.addr]));
  const aOffer = await a.next((m) => m.type === 'sfu_offer'); // a had nothing to download until b came
  assert.match(aOffer.sdp, /^v=0/);
  assert.deepEqual(new Set(Object.values(aOffer.streams).map((s) => s.addr)), new Set([b.addr]));
  const bOffer = await b.next((m) => m.type === 'sfu_offer');
  assert.deepEqual(new Set(Object.values(bOffer.streams).map((s) => s.addr)), new Set([a.addr]));
  b.send({ type: 'sfu_join', room: 'nope', ref: 'j3' });
  assert.equal((await b.next((m) => m.ref === 'j3')).error, 'bad room');
  b.ws.close();
  await a.next((m) => m.type === 'sfu_members' && m.members.length === 1);
  a.ws.close();
});

test('relay without the SFU refuses large calls and says so', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, sfu: null });
  t.after(() => relay.close());
  assert.equal((await (await fetch(`http://127.0.0.1:${relay.port}/api/ice`)).json()).sfu, false);
  const a = await device(relay.port, '@ana.veil');
  a.send({ type: 'sfu_join', room: ROOM, ref: 'j' });
  assert.match((await a.next((m) => m.ref === 'j')).error, /not available/);
  a.ws.close();
});

test('call protocol: SFU rooms in invites, answers and rosters', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const inv = parseCallSignal({ kind: 'call', op: 'invite', id: 'call12345', video: true, sfu: ROOM, e2ee: true, key, kid: 3 });
  assert.equal(inv.sfu, ROOM);
  assert.equal(inv.sdp, undefined);
  assert.throws(() => parseCallSignal({ kind: 'call', op: 'invite', id: 'call12345', sfu: ROOM, e2ee: false }), /frame encryption/);
  assert.throws(() => parseCallSignal({ kind: 'call', op: 'answer', id: 'call12345', sfu: 'x', e2ee: true, key }), /bad room/);
  assert.throws(() => parseCallSignal({ kind: 'call', op: 'offer', id: 'call12345', sfu: ROOM, e2ee: true, key }), /bad sdp/);
  const addrs = Array.from({ length: 20 }, (_, i) => `@u${i}.veil#${String(i).padStart(16, 'a')}`);
  assert.throws(() => parseCallSignal({ kind: 'call', op: 'roster', id: 'call12345', members: addrs }), /bad roster/);
  assert.equal(parseCallSignal({ kind: 'call', op: 'roster', id: 'call12345', members: addrs, sfu: ROOM }).members.length, 20);
  const members = new Set([addrs[0]]);
  assert.equal(mergeRoster(members, addrs, new Set()).length, 7); // mesh cap
  assert.equal(mergeRoster(members, addrs, new Set(), MAX_SFU_DEVICES).length, 12);
  assert.equal(preferRoom(null, 'b'.repeat(16)), 'b'.repeat(16));
  assert.equal(preferRoom('a'.repeat(16), 'b'.repeat(16)), 'a'.repeat(16));
});
