import test from 'node:test';
import assert from 'node:assert/strict';
import { b64, newMessageId } from '../shared/crypto.js';
import {
  parseCallSignal, inviteExpired, glareYield, formatDuration, INVITE_MAX_AGE_MS,
} from '../shared/callproto.js';
import {
  importMediaKey, encryptFrame, decryptFrame, clearBytesFor, OVERHEAD,
} from '../shared/frame-crypto.js';
import { createRelay } from '../server/relay.js';

const key32 = () => b64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';

test('call signals are validated before use', () => {
  const id = newMessageId();
  const inv = parseCallSignal({ kind: 'call', op: 'invite', id, video: true, sdp: SDP, e2ee: true, key: key32(), extra: 'x' });
  assert.deepEqual(Object.keys(inv).sort(), ['e2ee', 'id', 'key', 'kid', 'op', 'sdp', 'video']);
  assert.equal(parseCallSignal({ kind: 'call', op: 'answer', id, sdp: SDP }).e2ee, false);
  assert.equal(parseCallSignal({ kind: 'call', op: 'hangup', id, reason: 'bogus' }).reason, 'ended');
  assert.equal(parseCallSignal({ kind: 'call', op: 'hangup', id, reason: 'answered-elsewhere' }).reason, 'answered-elsewhere');
  const bad = [
    { kind: 'text', op: 'invite', id },
    { kind: 'call', op: 'invite', id: 'short', sdp: SDP },
    { kind: 'call', op: 'dial', id },
    { kind: 'call', op: 'invite', id, sdp: 'not sdp' },
    { kind: 'call', op: 'invite', id, sdp: SDP + 'a'.repeat(70_000) },
    { kind: 'call', op: 'invite', id, sdp: SDP, e2ee: true }, // missing key
    { kind: 'call', op: 'invite', id, sdp: SDP, e2ee: true, key: b64(new Uint8Array(16)) }, // short key
  ];
  for (const p of bad) assert.throws(() => parseCallSignal(p), undefined, JSON.stringify(p).slice(0, 60));
});

test('stale invites are missed calls; glare picks exactly one winner', () => {
  const now = Date.now();
  assert.equal(inviteExpired(now - 1000, now), false);
  assert.equal(inviteExpired(now - INVITE_MAX_AGE_MS - 1, now), true);
  assert.equal(inviteExpired(undefined, now), true);
  for (let i = 0; i < 50; i++) {
    const a = newMessageId(), b = newMessageId();
    assert.equal(glareYield(a, b) !== glareYield(b, a), true, 'one side yields, the other does not');
  }
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65_400), '1:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
});

test('media frames: header stays clear, the rest is sealed', async (t) => {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await importMediaKey(raw);
  const frame = globalThis.crypto.getRandomValues(new Uint8Array(1200));
  const clear = clearBytesFor('video', 'key');
  assert.equal(clear, 10);
  assert.equal(clearBytesFor('video', 'delta'), 3);
  assert.equal(clearBytesFor('audio'), 1);

  const sealed = new Uint8Array(await encryptFrame(key, frame.buffer, clear));
  assert.equal(sealed.length, frame.length + OVERHEAD);
  assert.deepEqual(sealed.subarray(0, clear), frame.subarray(0, clear), 'codec header untouched');
  assert.notDeepEqual(sealed.subarray(clear, 100), frame.subarray(clear, 100));
  assert.deepEqual(new Uint8Array(await decryptFrame(key, sealed.buffer, clear)), frame);

  await t.test('fresh IV per frame', async () => {
    const again = new Uint8Array(await encryptFrame(key, frame.buffer, clear));
    assert.notDeepEqual(again.subarray(clear, clear + 32), sealed.subarray(clear, clear + 32));
  });
  await t.test('tampering with the clear header or body is detected', async () => {
    const h = sealed.slice(); h[0] ^= 1;
    await assert.rejects(decryptFrame(key, h.buffer, clear));
    const b = sealed.slice(); b[500] ^= 1;
    await assert.rejects(decryptFrame(key, b.buffer, clear));
  });
  await t.test('the other direction’s key cannot open it', async () => {
    const other = await importMediaKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    await assert.rejects(decryptFrame(other, sealed.buffer, clear));
  });
  await t.test('frames shorter than the header round-trip', async () => {
    const tiny = new Uint8Array([7, 8]);
    const s = await encryptFrame(key, tiny.buffer, 10);
    assert.deepEqual(new Uint8Array(await decryptFrame(key, s, 10)), tiny);
    await assert.rejects(decryptFrame(key, new Uint8Array(5).buffer, 1), /too short/);
  });
});

test('relay serves ICE config and allows camera/microphone for itself only', async (t) => {
  const iceServers = [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }];
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, iceServers });
  t.after(() => relay.close());
  const r = await fetch(`http://127.0.0.1:${relay.port}/api/ice`);
  assert.deepEqual(await r.json(), { iceServers, sfu: true, turn: false });
  // with operator TURN, logins go out only over a signed-in socket: the public endpoint says only that there is one
  const withTurn = await createRelay({ port: 0, dataFile: null, log: () => {}, iceServers: [], turn: { urls: ['turn:t.example.test:3478'], secret: 's'.repeat(32), ttl: 600 } });
  t.after(() => withTurn.close());
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${withTurn.port}/api/ice`)).json(), { iceServers: [], sfu: true, turn: true });
  assert.match(r.headers.get('permissions-policy'), /camera=\(self\), microphone=\(self\)/);
  for (const f of ['/calls.js', '/e2ee-worker.js', '/shared/frame-crypto.js', '/shared/callproto.js']) {
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}${f}`)).status, 200, f);
  }
  const none = await createRelay({ port: 0, dataFile: null, log: () => {}, iceServers: [] });
  t.after(() => none.close());
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${none.port}/api/ice`)).json(), { iceServers: [], sfu: true, turn: false });
});

test('group calls: roster, mesh, sender-key ids', async () => {
  const { mergeRoster, offersTo, nextKid, isDeviceAddr, MAX_CALL_DEVICES } = await import('../shared/callproto.js');
  const { frameKid } = await import('../shared/frame-crypto.js');
  const id = newMessageId();
  const a = '@ana.veil#0123456789abcdef';
  const b = '@ben.veil#fedcba9876543210';
  assert.equal(isDeviceAddr(a), true);
  for (const bad of ['@ana.veil', 'ana#0123456789abcdef', '@ana.veil#xyz', 5, null]) assert.equal(isDeviceAddr(bad), false, String(bad));
  assert.deepEqual(parseCallSignal({ kind: 'call', op: 'roster', id, members: [a, b, a] }).members, [a, b], 'deduped');
  assert.throws(() => parseCallSignal({ kind: 'call', op: 'roster', id, members: [a, 'nope'] }));
  assert.throws(() => parseCallSignal({ kind: 'call', op: 'roster', id, members: Array(MAX_CALL_DEVICES + 1).fill(a) }));
  const k = parseCallSignal({ kind: 'call', op: 'key', id, key: key32(), kid: 7 });
  assert.equal(k.kid, 7);
  for (const kid of [-1, 256, 1.5, '3']) assert.throws(() => parseCallSignal({ kind: 'call', op: 'key', id, key: key32(), kid }));
  assert.equal(parseCallSignal({ kind: 'call', op: 'offer', id, sdp: SDP, e2ee: true, key: key32(), kid: 2 }).kid, 2);
  assert.equal(parseCallSignal({ kind: 'call', op: 'media', id, screen: true }).screen, true);

  // exactly one side of every pair sends the offer
  assert.notEqual(offersTo(a, b), offersTo(b, a));
  // someone who left can't be brought back by a stale roster; the mesh never grows past the cap
  const members = new Set([a]);
  const left = new Set([b]);
  assert.deepEqual(mergeRoster(members, [a, b], left), []);
  const many = Array.from({ length: 12 }, (_, i) => `@user${i}.veil#${String(i).padStart(16, '0')}`);
  assert.equal(mergeRoster(members, many, left).length, MAX_CALL_DEVICES - 1);
  assert.equal(members.size, MAX_CALL_DEVICES);
  assert.equal(nextKid(255), 0);

  // frames carry their key id; a receiver holding old + new keys opens both, others fail
  const k0 = await importMediaKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const k1 = await importMediaKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const frame = globalThis.crypto.getRandomValues(new Uint8Array(300));
  const s0 = await encryptFrame(k0, frame.buffer, 3, 0);
  const s1 = await encryptFrame(k1, frame.buffer, 3, 1);
  assert.equal(frameKid(s1), 1);
  const keys = new Map([[0, k0], [1, k1]]);
  assert.deepEqual(new Uint8Array(await decryptFrame((kid) => keys.get(kid), s0, 3)), frame);
  assert.deepEqual(new Uint8Array(await decryptFrame((kid) => keys.get(kid), s1, 3)), frame);
  await assert.rejects(decryptFrame((kid) => new Map([[1, k1]]).get(kid), s0, 3), /unknown key id/);
  const swapped = new Uint8Array(s1.slice(0)); swapped[swapped.length - 1] = 0; // relabel the key id
  await assert.rejects(decryptFrame((kid) => keys.get(kid), swapped.buffer, 3));
});
