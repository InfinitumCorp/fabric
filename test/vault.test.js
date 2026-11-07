import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, memoryBackend, PBKDF2_ITERATIONS } from '../shared/vault.js';
import {
  generateUserIdentity, publicIdentity, ecdh, signBytes, verifyBytes, generateIdentity,
} from '../shared/crypto.js';
import { SessionManager, emptyStore } from '../shared/session.js';

const FAST = { iterations: 1000 }; // tests only; real vaults use PBKDF2_ITERATIONS
const STATE = { handle: '@alice.veil', threads: { '@bob.veil': [{ text: 'the launch code is 0600' }] } };

async function sameKeys(jwkIdentity, vaultIdentity) {
  // the non-extractable keys must behave exactly like the originals
  const peer = await generateIdentity();
  assert.deepEqual(await ecdh(vaultIdentity.dh.privateKey, peer.publicJwk), await ecdh(jwkIdentity.dh.privateJwk, peer.publicJwk));
  const msg = new TextEncoder().encode('check');
  assert.ok(await verifyBytes(jwkIdentity.sig.publicJwk, await signBytes(vaultIdentity.sig.privateKey, msg), msg));
}

/** Everything in the backend that is not a CryptoKey, as text. */
const dump = (backend) => JSON.stringify([...backend.map.entries()].filter(([, v]) => !(v instanceof CryptoKey)));

test('device mode: keys come back non-extractable and still work', async () => {
  const backend = memoryBackend();
  const jwks = await generateUserIdentity();
  const created = await new Vault(backend, FAST).create({ identity: jwks, state: STATE });
  await sameKeys(jwks, created);

  const { identity, state } = await new Vault(backend, FAST).unlock();
  assert.deepEqual(state, STATE);
  for (const part of ['dh', 'sig']) {
    assert.equal(identity[part].privateKey.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('jwk', identity[part].privateKey));
  }
  await sameKeys(jwks, identity);
  assert.equal(backend.map.get('deviceKey').extractable, false);
});

test('nothing sensitive is stored in the clear', async () => {
  const backend = memoryBackend();
  const jwks = await generateUserIdentity();
  await new Vault(backend, FAST).create({ identity: jwks, state: STATE });
  const text = dump(backend);
  assert.ok(!text.includes('launch code'));
  assert.ok(!text.includes(jwks.dh.privateJwk.d));
  assert.ok(!text.includes(jwks.sig.privateJwk.d));
  assert.ok(text.includes(jwks.dh.publicJwk.x), 'public keys are fine to keep readable');
});

test('passphrase mode: locked without it, wrong one refused, right one opens', async () => {
  const backend = memoryBackend();
  await new Vault(backend, FAST).create({ identity: await generateUserIdentity(), state: STATE, passphrase: 'correct horse battery' });
  assert.equal(backend.map.get('deviceKey'), undefined, 'no device key to steal');
  const v = new Vault(backend, FAST);
  await assert.rejects(v.unlock(), (e) => e.code === 'locked');
  await assert.rejects(v.unlock('wrong horse battery'), (e) => e.code === 'bad-passphrase');
  assert.equal(v.unlocked, false);
  assert.deepEqual((await v.unlock('correct horse battery')).state, STATE);
});

test('set, change and remove a passphrase without losing keys or data', async () => {
  const backend = memoryBackend();
  const jwks = await generateUserIdentity();
  const v = new Vault(backend, FAST);
  await v.create({ identity: jwks, state: STATE });

  await v.setPassphrase('first passphrase');
  assert.equal((await v.meta()).mode, 'passphrase');
  assert.equal(backend.map.get('deviceKey'), undefined);
  await assert.rejects(new Vault(backend, FAST).unlock(), (e) => e.code === 'locked');
  let r = await new Vault(backend, FAST).unlock('first passphrase');
  await sameKeys(jwks, r.identity);
  assert.deepEqual(r.state, STATE);

  // changing needs the current passphrase; a failed attempt changes nothing
  await assert.rejects(v.setPassphrase('second passphrase', 'not it at all'), (e) => e.code === 'bad-passphrase');
  await new Vault(backend, FAST).unlock('first passphrase');
  await v.setPassphrase('second passphrase', 'first passphrase');
  await assert.rejects(new Vault(backend, FAST).unlock('first passphrase'), (e) => e.code === 'bad-passphrase');
  r = await new Vault(backend, FAST).unlock('second passphrase');
  await sameKeys(jwks, r.identity);

  await v.setPassphrase(null, 'second passphrase');
  assert.equal((await v.meta()).mode, 'device');
  r = await new Vault(backend, FAST).unlock();
  await sameKeys(jwks, r.identity);
  assert.deepEqual(r.state, STATE);
});

test('short passphrases are refused', async () => {
  await assert.rejects(
    new Vault(memoryBackend(), FAST).create({ identity: await generateUserIdentity(), state: {}, passphrase: 'short' }),
    (e) => e.code === 'weak',
  );
});

test('tampered or swapped blobs do not open', async () => {
  const backend = memoryBackend();
  await new Vault(backend, FAST).create({ identity: await generateUserIdentity(), state: STATE });
  const original = structuredClone(backend.map.get('identity'));

  // swap the DH and signing blobs: AAD labels make each blob valid only in its own slot
  backend.map.set('identity', { dh: { ...original.dh, wrapped: original.sig.wrapped }, sig: { ...original.sig, wrapped: original.dh.wrapped } });
  await assert.rejects(new Vault(backend, FAST).unlock());
  backend.map.set('identity', original);

  const st = structuredClone(backend.map.get('state'));
  const ct = Buffer.from(st.ct, 'base64'); ct[5] ^= 1;
  backend.map.set('state', { ...st, ct: ct.toString('base64') });
  await assert.rejects(new Vault(backend, FAST).unlock());
});

test('saves are serialized, coalesced, and only resolve once the newest is written', async () => {
  const backend = memoryBackend();
  const v = new Vault(backend, FAST);
  await v.create({ identity: await generateUserIdentity(), state: { n: 0 } });
  const writes = [];
  const put = backend.putMany;
  backend.putMany = async (o) => { writes.push(o); return put(o); };

  const saves = [1, 2, 3, 4, 5].map((n) => v.save({ n }));
  await saves[0]; // resolves only when the newest snapshot is on disk
  assert.equal((await new Vault(backend, FAST).unlock()).state.n, 5);
  await Promise.all(saves);
  assert.ok(writes.length <= 2, `coalesced into ${writes.length} writes`);

  v.lock();
  await assert.rejects(v.save({ n: 6 }), (e) => e.code === 'locked');
});

test('a vault identity (non-extractable) runs X3DH + ratchet sessions', async () => {
  const backend = memoryBackend();
  const bobJwks = await generateUserIdentity();
  const bob = await new Vault(backend, FAST).create({ identity: bobJwks, state: {} });
  const alice = await generateUserIdentity();
  const mb = new SessionManager({ handle: '@bob.veil', deviceId: 'bbbbbbbbbbbbbbbb', identity: bob, store: emptyStore(), fetchBundle: async () => {} });
  const pub = await mb.maintainPreKeys(0);
  const ma = new SessionManager({
    handle: '@alice.veil', deviceId: 'aaaaaaaaaaaaaaaa', identity: alice, store: emptyStore(),
    fetchBundle: async () => ({ identity: publicIdentity(bobJwks), spk: pub.spk, opk: pub.opks[0] }),
  });
  const env = await ma.encrypt('@bob.veil#bbbbbbbbbbbbbbbb', { text: 'hi' });
  assert.equal((await mb.decrypt(env, publicIdentity(alice))).text, 'hi');
  const back = await mb.encrypt('@alice.veil#aaaaaaaaaaaaaaaa', { text: 'hello' });
  assert.equal((await ma.decrypt(back, publicIdentity(bobJwks))).text, 'hello');
});

test('real vaults use 600,000 PBKDF2 iterations', async () => {
  const backend = memoryBackend();
  await new Vault(backend).create({ identity: await generateUserIdentity(), state: {}, passphrase: 'a real passphrase' });
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  assert.equal((await new Vault(backend).meta()).kdf.iterations, 600_000);
  await new Vault(backend).unlock('a real passphrase');
});
