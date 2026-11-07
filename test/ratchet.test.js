import test from 'node:test';
import assert from 'node:assert/strict';
import { generateUserIdentity, publicIdentity, keyId } from '../shared/crypto.js';
import {
  generateSignedPreKey, generateOneTimePreKeys, publicPreKeys, verifySignedPreKey,
  initiateSession, acceptSession, ratchetEncrypt, ratchetDecrypt, MAX_SKIP,
} from '../shared/ratchet.js';
import { SessionManager, emptyStore, routingOf } from '../shared/session.js';

const A = '@alice.veil';
const B = '@bob.veil';

async function bobWithPrekeys() {
  const identity = await generateUserIdentity();
  const spk = await generateSignedPreKey(identity.sig.privateJwk, 1);
  const opks = await generateOneTimePreKeys(1, 3);
  const prekeys = { spks: { 1: spk }, opks: Object.fromEntries(opks.map((k) => [k.id, k])) };
  const pub = publicPreKeys(spk, opks);
  return { identity, prekeys, pub };
}

/** Alice starts a session with Bob; returns both states after Bob reads her first message. */
async function pair({ withOpk = true } = {}) {
  const alice = await generateUserIdentity();
  const bob = await bobWithPrekeys();
  const bundle = { identity: publicIdentity(bob.identity), spk: bob.pub.spk, opk: withOpk ? bob.pub.opks[0] : null };
  let sa = await initiateSession({ myHandle: A, myIdentity: alice, peerHandle: B, bundle });
  const r = routingOf({ id: 'm0', from: A, to: B, ts: 1 });
  const first = await ratchetEncrypt(sa, { text: 'hello bob' }, r);
  sa = first.state;
  const { state, usedOpkId } = await acceptSession({
    myHandle: B, myIdentity: bob.identity, prekeys: bob.prekeys, peerHandle: A,
    peerIdentity: publicIdentity(alice), pre: first.header.pre,
  });
  const opened = await ratchetDecrypt(state, first.header, first.ct, r);
  assert.deepEqual(opened.payload, { text: 'hello bob' });
  return { sa, sb: opened.state, usedOpkId, alice, bob };
}

let seq = 0;
const route = (from, to) => routingOf({ id: `m${++seq}`, from, to, ts: seq });

async function send(state, text, from, to) {
  const r = route(from, to);
  const out = await ratchetEncrypt(state, { text }, r);
  return { state: out.state, msg: { header: out.header, ct: out.ct, r } };
}
const recv = (state, m) => ratchetDecrypt(state, m.header, m.ct, m.r);

test('X3DH: both sides agree, with and without a one-time prekey', async () => {
  for (const withOpk of [true, false]) {
    const { sa, sb, usedOpkId } = await pair({ withOpk });
    assert.equal(sa.ad, sb.ad);
    assert.equal(usedOpkId, withOpk ? 1 : null);
  }
});

test('signed prekeys: a forged signature is refused', async () => {
  const bob = await bobWithPrekeys();
  const mallory = await generateUserIdentity();
  assert.ok(await verifySignedPreKey(bob.identity.sig.publicJwk, bob.pub.spk));
  assert.ok(!(await verifySignedPreKey(mallory.sig.publicJwk, bob.pub.spk)));
  const swapped = { ...bob.pub.spk, pub: bob.pub.opks[0].pub }; // relay substitutes its own key
  await assert.rejects(initiateSession({
    myHandle: A, myIdentity: mallory, peerHandle: B,
    bundle: { identity: publicIdentity(bob.identity), spk: swapped },
  }), /signature/);
});

test('a one-time prekey cannot be used twice', async () => {
  const { bob, alice } = await pair();
  // simulate the responder having deleted OPK 1 after first use
  delete bob.prekeys.opks[1];
  const bundle = { identity: publicIdentity(bob.identity), spk: bob.pub.spk, opk: bob.pub.opks[0] };
  const s = await initiateSession({ myHandle: A, myIdentity: alice, peerHandle: B, bundle });
  const out = await ratchetEncrypt(s, { text: 'again' }, 'r');
  await assert.rejects(acceptSession({
    myHandle: B, myIdentity: bob.identity, prekeys: bob.prekeys, peerHandle: A,
    peerIdentity: publicIdentity(alice), pre: out.header.pre,
  }), /already used/);
});

test('long alternating conversation decrypts and ratchets every turn', async () => {
  let { sa, sb } = await pair();
  const seen = new Set([keyId(sa.DHs.publicJwk)]);
  for (let i = 0; i < 20; i++) {
    let m;
    ({ state: sb, msg: m } = await send(sb, `bob ${i}`, B, A));
    let o = await recv(sa, m); sa = o.state;
    assert.equal(o.payload.text, `bob ${i}`);
    ({ state: sa, msg: m } = await send(sa, `alice ${i}`, A, B));
    o = await recv(sb, m); sb = o.state;
    assert.equal(o.payload.text, `alice ${i}`);
    assert.ok(!seen.has(keyId(sa.DHs.publicJwk)), 'a fresh ratchet key every turn');
    seen.add(keyId(sa.DHs.publicJwk));
  }
  assert.equal(sa.pre, null, 'setup info stops once the peer has replied');
});

test('out-of-order and lost messages, across ratchet steps', async () => {
  let { sa, sb } = await pair();
  const batch1 = [];
  for (let i = 0; i < 4; i++) { let m; ({ state: sa, msg: m } = await send(sa, `a${i}`, A, B)); batch1.push(m); }
  // Bob reads a3 first, then replies, then Alice sends more, then Bob reads the stragglers
  let o = await recv(sb, batch1[3]); sb = o.state; assert.equal(o.payload.text, 'a3');
  let reply; ({ state: sb, msg: reply } = await send(sb, 'b0', B, A));
  o = await recv(sa, reply); sa = o.state;
  let late; ({ state: sa, msg: late } = await send(sa, 'a-new', A, B));
  o = await recv(sb, late); sb = o.state; assert.equal(o.payload.text, 'a-new');
  for (const i of [1, 0, 2]) { o = await recv(sb, batch1[i]); sb = o.state; assert.equal(o.payload.text, `a${i}`); }
  assert.equal(Object.keys(sb.skipped).length, 0, 'skipped keys are deleted once used');
});

test('forward secrecy: replayed messages fail and no old keys survive in state', async () => {
  let { sa, sb } = await pair();
  let m; ({ state: sa, msg: m } = await send(sa, 'secret', A, B));
  const o = await recv(sb, m);
  const after = o.state;
  await assert.rejects(recv(after, m), 'message key was deleted after use');
  // a full copy of Bob's later state contains nothing that opens the old message
  const dump = JSON.stringify(after);
  assert.ok(!Object.keys(after.skipped).length);
  assert.ok(!dump.includes(sb.CKr ?? '\u0000'), 'old receiving chain key is gone');
});

test('post-compromise: a leaked state stops working after the next round trip', async () => {
  let { sa, sb } = await pair();
  const stolenBob = structuredClone(sb); // attacker copies Bob's device state now
  let m;
  ({ state: sb, msg: m } = await send(sb, 'r1', B, A)); sa = (await recv(sa, m)).state;
  ({ state: sa, msg: m } = await send(sa, 'r2', A, B)); sb = (await recv(sb, m)).state;
  ({ state: sb, msg: m } = await send(sb, 'r3', B, A)); sa = (await recv(sa, m)).state;
  ({ state: sa, msg: m } = await send(sa, 'after healing', A, B));
  assert.equal((await recv(sb, m)).payload.text, 'after healing');
  await assert.rejects(recv(stolenBob, m), 'stolen state cannot follow the new DH ratchet');
});

test('tampering with ciphertext, header or routing is rejected without changing state', async () => {
  let { sa, sb } = await pair();
  let m; ({ state: sa, msg: m } = await send(sa, 'x', A, B));
  const ct = Buffer.from(m.ct, 'base64'); ct[3] ^= 1;
  await assert.rejects(recv(sb, { ...m, ct: ct.toString('base64') }));
  await assert.rejects(recv(sb, { ...m, header: { ...m.header, n: m.header.n + 1 } }));
  await assert.rejects(recv(sb, { ...m, r: m.r.replace(B, '@carol.veil') }));
  assert.equal((await recv(sb, m)).payload.text, 'x', 'the genuine message still opens');
});

test('refuses absurd skips (memory exhaustion)', async () => {
  let { sa, sb } = await pair();
  let m; ({ state: sa, msg: m } = await send(sa, 'x', A, B));
  await assert.rejects(recv(sb, { ...m, header: { ...m.header, n: MAX_SKIP + 5 } }), /skipped/);
});

const DEV = { [A]: 'aaaaaaaaaaaaaaaa', [B]: 'bbbbbbbbbbbbbbbb' };
const addr = (h) => `${h}#${DEV[h]}`;
const handleOf = (a) => a.slice(0, a.lastIndexOf('#'));

test('SessionManager: simultaneous first messages from both sides both get through', async () => {
  const relayPrekeys = {};
  const ids = { [A]: await generateUserIdentity(), [B]: await generateUserIdentity() };
  const mk = (h) => new SessionManager({
    handle: h, deviceId: DEV[h], identity: ids[h], store: emptyStore(),
    fetchBundle: async (peer) => {
      const p = relayPrekeys[peer];
      return { identity: publicIdentity(ids[handleOf(peer)]), spk: p.spk, opk: p.opks.shift() || null };
    },
  });
  const ma = mk(A), mb = mk(B);
  relayPrekeys[addr(A)] = await ma.maintainPreKeys(0);
  relayPrekeys[addr(B)] = await mb.maintainPreKeys(0);
  assert.equal(relayPrekeys[addr(A)].opks.length, 50);

  // both send before either has received anything
  const fromA = await ma.encrypt(addr(B), { text: 'hi from alice' });
  const fromB = await mb.encrypt(addr(A), { text: 'hi from bob' });
  assert.equal(fromA.fromDevice, DEV[A]);
  assert.equal(fromA.toDevice, DEV[B]);
  assert.deepEqual(await mb.decrypt(fromA, publicIdentity(ids[A])), { text: 'hi from alice' });
  assert.deepEqual(await ma.decrypt(fromB, publicIdentity(ids[B])), { text: 'hi from bob' });

  // and the conversation keeps working in both directions afterwards
  for (let i = 0; i < 3; i++) {
    assert.equal((await mb.decrypt(await ma.encrypt(addr(B), { text: `a${i}` }), publicIdentity(ids[A]))).text, `a${i}`);
    assert.equal((await ma.decrypt(await mb.encrypt(addr(A), { text: `b${i}` }), publicIdentity(ids[B]))).text, `b${i}`);
  }
  // one-time prekeys consumed on the device as well as on the relay
  assert.equal(Object.keys(mb.store.prekeys.opks).length, 49);

  // a message claiming to be from Alice but checked against the wrong identity is refused
  const impostor = publicIdentity(await generateUserIdentity());
  await assert.rejects(mb.decrypt(await ma.encrypt(addr(B), { text: 'z' }), impostor));

  // a ciphertext re-addressed to another device of the same account does not open
  const env = await ma.encrypt(addr(B), { text: 'for one device' });
  await assert.rejects(mb.decrypt({ ...env, fromDevice: 'cccccccccccccccc' }, publicIdentity(ids[A])));
});

test('SessionManager: operations are serialized', async () => {
  const ids = { [A]: await generateUserIdentity(), [B]: await generateUserIdentity() };
  const mb = new SessionManager({ handle: B, deviceId: DEV[B], identity: ids[B], store: emptyStore(), fetchBundle: async () => {} });
  const pub = await mb.maintainPreKeys(0);
  const ma = new SessionManager({
    handle: A, deviceId: DEV[A], identity: ids[A], store: emptyStore(),
    fetchBundle: async () => ({ identity: publicIdentity(ids[B]), spk: pub.spk, opk: pub.opks[0] }),
  });
  // fire 10 encrypts at once: counters must come out 0..9 with no duplicates
  const envs = await Promise.all(Array.from({ length: 10 }, (_, i) => ma.encrypt(addr(B), { text: String(i) })));
  assert.deepEqual(envs.map((e) => e.header.n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const out = await Promise.all(envs.reverse().map((e) => mb.decrypt(e, publicIdentity(ids[A]))));
  assert.deepEqual(out.map((p) => p.text), ['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']);
});

test('SessionManager: reset by handle drops every device of that contact', async () => {
  const ids = { [A]: await generateUserIdentity(), [B]: await generateUserIdentity() };
  const mb = new SessionManager({ handle: B, deviceId: DEV[B], identity: ids[B], store: emptyStore(), fetchBundle: async () => {} });
  const pub = await mb.maintainPreKeys(0);
  const ma = new SessionManager({
    handle: A, deviceId: DEV[A], identity: ids[A], store: emptyStore(),
    fetchBundle: async () => ({ identity: publicIdentity(ids[B]), spk: pub.spk, opk: null }),
  });
  await ma.encrypt(addr(B), { text: '1' });
  await ma.encrypt(`${B}#dddddddddddddddd`, { text: '2' });
  assert.equal(Object.keys(ma.store.sessions).length, 2);
  await ma.reset(`${B}#dddddddddddddddd`);
  assert.deepEqual(Object.keys(ma.store.sessions), [addr(B)]);
  await ma.reset(B);
  assert.deepEqual(Object.keys(ma.store.sessions), []);
});
