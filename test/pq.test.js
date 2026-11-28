import test from 'node:test';
import assert from 'node:assert/strict';
import { generateUserIdentity, publicIdentity, b64, unb64 } from '../shared/crypto.js';
import {
  generateSignedPreKey, generateOneTimePreKeys, publicPreKeys, verifyPqPreKey,
  initiateSession, acceptSession, ratchetEncrypt, ratchetDecrypt,
} from '../shared/ratchet.js';
import { SessionManager, emptyStore, routingOf } from '../shared/session.js';
import { kemKeygen, kemEncapsulate, kemDecapsulate } from '../shared/pq.js';

const A = '@alice.veil';
const B = '@bob.veil';
const r0 = routingOf({ id: 'm0', from: A, to: B, ts: 1 });

async function bob({ pq = true } = {}) {
  const identity = await generateUserIdentity();
  const spk = await generateSignedPreKey(identity.sig.privateJwk, 1);
  if (!pq) delete spk.pq; // a client from before v3
  const opks = await generateOneTimePreKeys(1, 2);
  return {
    identity, spk,
    prekeys: { spks: { 1: spk }, opks: Object.fromEntries(opks.map((k) => [k.id, k])) },
    bundle: { identity: publicIdentity(identity), ...publicPreKeys(spk, opks), opk: publicPreKeys(spk, opks).opks[0] },
  };
}

async function setup(b, alice, opts = {}) {
  const sa = await initiateSession({ myHandle: A, myIdentity: alice, peerHandle: B, bundle: b.bundle, ...opts });
  const first = await ratchetEncrypt(sa, { text: 'hello bob' }, r0);
  return { sa: first.state, first };
}

const accept = (b, alice, pre, opts = {}) => acceptSession({
  myHandle: B, myIdentity: b.identity, prekeys: b.prekeys, peerHandle: A, peerIdentity: publicIdentity(alice), pre, ...opts,
});

const flip = (s) => { const x = unb64(s); x[10] ^= 1; return b64(x); };

test('ML-KEM-768: encapsulate/decapsulate agree; a changed ciphertext gives another secret', () => {
  const { publicKey, secretKey } = kemKeygen();
  assert.equal(publicKey.length, 1184);
  const { cipherText, sharedSecret } = kemEncapsulate(publicKey);
  assert.equal(cipherText.length, 1088);
  assert.deepEqual(kemDecapsulate(cipherText, secretKey), sharedSecret);
  const bad = cipherText.slice(); bad[0] ^= 1;
  assert.notDeepEqual(kemDecapsulate(bad, secretKey), sharedSecret);
});

test('PQXDH: a PQ bundle gives a v3 session both ends agree on, and replies flow', async () => {
  const alice = await generateUserIdentity();
  const b = await bob();
  assert.ok(await verifyPqPreKey(b.bundle.identity.sig, b.bundle.spk));
  const { sa, first } = await setup(b, alice);
  assert.equal(sa.v, 3);
  assert.equal(unb64(first.header.pre.pq.ct).length, 1088);
  const { state } = await accept(b, alice, first.header.pre);
  assert.equal(state.v, 3);
  const opened = await ratchetDecrypt(state, first.header, first.ct, r0);
  assert.deepEqual(opened.payload, { text: 'hello bob' });
  assert.equal(opened.state.ad, sa.ad);
  assert.match(new TextDecoder().decode(unb64(sa.ad)), /^FABRIC\/v3\/AD\|/);
  const r1 = routingOf({ id: 'm1', from: B, to: A, ts: 2 });
  const back = await ratchetEncrypt(opened.state, { text: 'hi alice' }, r1);
  assert.deepEqual((await ratchetDecrypt(sa, back.header, back.ct, r1)).payload, { text: 'hi alice' });
});

test('fallback: no PQ key in the bundle gives v2; a v2 setup is still accepted by a PQ device', async () => {
  const alice = await generateUserIdentity();
  const old = await bob({ pq: false });
  const { sa, first } = await setup(old, alice);
  assert.equal(sa.v, 2);
  assert.equal(first.header.pre.pq, undefined);
  const { state } = await accept(old, alice, first.header.pre);
  assert.equal((await ratchetDecrypt(state, first.header, first.ct, r0)).payload.text, 'hello bob');

  // an old initiator (no pq in its setup) talking to a device that has PQ keys
  const b = await bob();
  const stripped = { ...b, bundle: { ...b.bundle, spk: { ...b.bundle.spk, pq: undefined } } };
  delete stripped.bundle.spk.pq;
  const legacy = await setup(stripped, alice);
  assert.equal(legacy.sa.v, 2);
  const acc = await accept(b, alice, legacy.first.header.pre);
  assert.equal(acc.state.v, 2);
  assert.equal((await ratchetDecrypt(acc.state, legacy.first.header, legacy.first.ct, r0)).payload.text, 'hello bob');
});

test('tampering: changed or removed KEM ciphertext fails to decrypt; a bad PQ signature is refused, not downgraded', async () => {
  const alice = await generateUserIdentity();
  const b = await bob();
  const { first } = await setup(b, alice);

  // ciphertext changed in transit: ML-KEM yields another secret and the AAD differs, so nothing opens
  const changed = { ...first.header, pre: { ...first.header.pre, pq: { ct: flip(first.header.pre.pq.ct) } } };
  const s1 = await accept(b, alice, changed.pre);
  await assert.rejects(ratchetDecrypt(s1.state, changed, first.ct, r0));

  // PQ part stripped from the setup: the responder builds a v2 session, which cannot open a v3 message
  const { pq, ...noPq } = first.header.pre;
  const strippedHeader = { ...first.header, pre: noPq };
  const s2 = await accept(b, alice, noPq);
  await assert.rejects(ratchetDecrypt(s2.state, strippedHeader, first.ct, r0));
  await assert.rejects(ratchetDecrypt(s2.state, first.header, first.ct, r0)); // and the AD differs too

  // malformed ciphertext
  await assert.rejects(accept(b, alice, { ...first.header.pre, pq: { ct: 'AAAA' } }), /bad post-quantum ciphertext/);

  // relay swaps in its own ML-KEM key (or a key signed for another prekey id): refused outright
  const evil = kemKeygen();
  const swapped = { ...b.bundle, spk: { ...b.bundle.spk, pq: { ...b.bundle.spk.pq, pub: b64(evil.publicKey) } } };
  await assert.rejects(initiateSession({ myHandle: A, myIdentity: alice, peerHandle: B, bundle: swapped }), /bad post-quantum prekey signature/);
  const otherId = { ...b.bundle, spk: { ...b.bundle.spk, id: 2 } };
  await assert.rejects(initiateSession({ myHandle: A, myIdentity: alice, peerHandle: B, bundle: otherId }));
});

test('pinning: once a device used PQ, setups without it are refused both ways', async () => {
  const alice = await generateUserIdentity();
  const b = await bob();
  const noPqBundle = { ...b.bundle, spk: { ...b.bundle.spk } };
  delete noPqBundle.spk.pq;
  await assert.rejects(
    initiateSession({ myHandle: A, myIdentity: alice, peerHandle: B, bundle: noPqBundle, requirePq: true }),
    /refusing a setup without it/,
  );
  const legacy = await setup({ ...b, bundle: noPqBundle }, alice);
  await assert.rejects(accept(b, alice, legacy.first.header.pre, { requirePq: true }), /refusing a setup without it/);
});

test('SessionManager: v3 end to end, pins the peer, refreshes a pre-v3 signed prekey', async () => {
  const ids = { a: await generateUserIdentity(), b: await generateUserIdentity() };
  const bundles = {};
  const mk = (handle, deviceId, identity) => new SessionManager({
    handle, deviceId, identity, store: emptyStore(), fetchBundle: async (peer) => bundles[peer],
  });
  const alice = mk(A, 'aaaaaaaaaaaaaaaa', ids.a);
  const bobM = mk(B, 'bbbbbbbbbbbbbbbb', ids.b);
  const up = await bobM.maintainPreKeys(0, { forceSpk: true });
  assert.ok(up.spk.pq?.pub && up.spk.pq?.sig);
  bundles[bobM.addr] = { identity: publicIdentity(ids.b), spk: up.spk, opk: up.opks[0] };

  const env = await alice.encrypt(bobM.addr, { text: 'pq hello' });
  assert.equal(alice.sessionKind(bobM.addr), 'pq');
  assert.ok(alice.pqPinned(bobM.addr));
  assert.deepEqual(await bobM.decrypt(env, publicIdentity(ids.a)), { text: 'pq hello' });
  assert.ok(bobM.pqPinned(alice.addr));

  // the relay later serves a bundle without the PQ key: Alice refuses instead of downgrading
  await alice.reset(bobM.addr);
  const { pq, ...plainSpk } = up.spk;
  bundles[bobM.addr] = { identity: publicIdentity(ids.b), spk: plainSpk };
  await assert.rejects(alice.encrypt(bobM.addr, { text: 'downgraded?' }), /refusing a setup without it/);

  // a store from before v3: its signed prekey has no PQ half and is replaced at once
  const legacy = mk(B, 'cccccccccccccccc', ids.b);
  const spk = await generateSignedPreKey(ids.b.sig.privateJwk, 1);
  delete spk.pq;
  legacy.store.prekeys.spks[1] = spk;
  legacy.store.prekeys.nextSpkId = 2;
  const refreshed = await legacy.maintainPreKeys(50);
  assert.equal(refreshed.spk.id, 2);
  assert.ok(refreshed.spk.pq);
  assert.ok(legacy.store.prekeys.spks[1], 'the old prekey stays for setups already in flight');
});

test('upgrade: a classical chat moves to post-quantum once the peer has a PQ key, at most one lookup a day', async () => {
  const ids = { a: await generateUserIdentity(), b: await generateUserIdentity() };
  const bundles = {};
  let lookups = 0;
  const mk = (handle, deviceId, identity) => new SessionManager({
    handle, deviceId, identity, store: emptyStore(), fetchBundle: async (peer) => { lookups++; return bundles[peer]; },
  });
  const alice = mk(A, 'aaaaaaaaaaaaaaaa', ids.a);
  const bobM = mk(B, 'bbbbbbbbbbbbbbbb', ids.b);
  const up = await bobM.maintainPreKeys(0, { forceSpk: true });
  const { pq, ...plainSpk } = up.spk; // Bob's app before the upgrade
  bundles[bobM.addr] = { identity: publicIdentity(ids.b), spk: plainSpk };

  const first = await alice.encrypt(bobM.addr, { text: 'classic' });
  assert.equal(alice.sessionKind(bobM.addr), 'classic');
  await bobM.decrypt(first, publicIdentity(ids.a));
  await alice.decrypt(await bobM.encrypt(alice.addr, { text: 'ok' }), publicIdentity(ids.b));

  // still no PQ key: one lookup, then none for a day
  lookups = 0;
  await alice.encrypt(bobM.addr, { text: 'still classic' });
  await alice.encrypt(bobM.addr, { text: 'and again' });
  assert.equal(lookups, 1);
  assert.equal(alice.sessionKind(bobM.addr), 'classic');

  // Bob updates his app; a day later Alice's next message starts a v3 session that Bob accepts
  bundles[bobM.addr] = { identity: publicIdentity(ids.b), spk: up.spk };
  alice.store.pqChecked[bobM.addr] -= 25 * 3600 * 1000;
  const env = await alice.encrypt(bobM.addr, { text: 'now post-quantum' });
  assert.ok(env.header.pre?.pq);
  assert.equal(alice.sessionKind(bobM.addr), 'pq');
  assert.deepEqual(await bobM.decrypt(env, publicIdentity(ids.a)), { text: 'now post-quantum' });
  assert.equal(bobM.sessionKind(alice.addr), 'pq');
  const reply = await bobM.encrypt(alice.addr, { text: 'pq reply' });
  assert.deepEqual(await alice.decrypt(reply, publicIdentity(ids.b)), { text: 'pq reply' });
  assert.ok(alice.pqPinned(bobM.addr) && bobM.pqPinned(alice.addr));
});
