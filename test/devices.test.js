import test from 'node:test';
import assert from 'node:assert/strict';
import { generateUserIdentity, generateSigningKey, generateIdentity, ecdh } from '../shared/crypto.js';
import {
  signDeviceList, verifyDeviceList, nextDeviceList, newDeviceId, deviceAddr, parseAddr,
  encodeLinkCode, decodeLinkCode, MAX_DEVICES,
} from '../shared/devices.js';
import {
  linkChannelKey, sealJson, openJson, newRecoveryKey, parseRecoveryKey, sealBackup, openBackup,
} from '../shared/channel.js';
import { Vault, memoryBackend } from '../shared/vault.js';

const H = '@alex.veil';

async function newDevice(name) {
  const keys = await generateUserIdentity();
  return { keys, entry: { id: newDeviceId(), name, dh: keys.dh.publicJwk, sig: keys.sig.publicJwk, addedAt: 1 } };
}

async function account() {
  const acct = await generateSigningKey();
  const d1 = await newDevice('Laptop');
  const list = await signDeviceList(acct.privateJwk, { handle: H, version: 1, account: acct.publicJwk, devices: [d1.entry] });
  return { acct, d1, list };
}

test('device lists: signed, pinned, monotonic', async (t) => {
  const { acct, d1, list } = await account();
  const p = await verifyDeviceList(list, { handle: H });
  assert.equal(p.devices[0].id, d1.entry.id);
  assert.equal(p.devices[0].dh.d, undefined, 'only public keys in the list');

  const d2 = await newDevice('Phone');
  const v2 = await signDeviceList(acct.privateJwk, nextDeviceList(p, { add: [d2.entry] }));
  const p2 = await verifyDeviceList(v2, { handle: H, account: acct.publicJwk, minVersion: 1 });
  assert.equal(p2.version, 2);
  assert.equal(p2.devices.length, 2);

  await t.test('a relay cannot add a device to the list', async () => {
    const evil = await newDevice('Mallory');
    const forged = { payload: { ...v2.payload, devices: [...v2.payload.devices, { ...evil.entry }].sort((a, b) => a.id.localeCompare(b.id)) }, sig: v2.sig };
    await assert.rejects(verifyDeviceList(forged, { handle: H, account: acct.publicJwk }), /signature/);
  });

  await t.test('a list signed by another account key is refused once pinned', async () => {
    const other = await generateSigningKey();
    const takeover = await signDeviceList(other.privateJwk, { ...v2.payload, version: 9, account: other.publicJwk });
    await verifyDeviceList(takeover, { handle: H }); // valid on its own …
    await assert.rejects(verifyDeviceList(takeover, { handle: H, account: acct.publicJwk }), /account key changed/);
  });

  await t.test('an older list cannot be replayed', async () => {
    await assert.rejects(verifyDeviceList(list, { handle: H, account: acct.publicJwk, minVersion: 2 }), /rolled back/);
  });

  await t.test('a list for another handle is refused', async () => {
    await assert.rejects(verifyDeviceList(v2, { handle: '@sam.veil' }), /another account/);
  });

  await t.test('removing a device, and the device cap', async () => {
    const v3 = await signDeviceList(acct.privateJwk, nextDeviceList(p2, { remove: [d1.entry.id] }));
    assert.deepEqual((await verifyDeviceList(v3, { handle: H, minVersion: 3 })).devices.map((d) => d.name), ['Phone']);
    const many = [];
    for (let i = 0; i <= MAX_DEVICES; i++) many.push((await newDevice('d' + i)).entry);
    const big = await signDeviceList(acct.privateJwk, { handle: H, version: 4, account: acct.publicJwk, devices: many });
    await assert.rejects(verifyDeviceList(big, { handle: H }), /device count/);
  });
});

test('addresses and link codes', async () => {
  const id = newDeviceId();
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.deepEqual(parseAddr(deviceAddr(H, id)), { handle: H, deviceId: id });
  const eph = await generateIdentity();
  const code = encodeLinkCode('abcdefghijklmnop1234', eph.publicJwk);
  const { mailbox, pub } = decodeLinkCode(`  ${code}\n`);
  assert.equal(mailbox, 'abcdefghijklmnop1234');
  assert.equal(pub.x, eph.publicJwk.x);
  assert.throws(() => decodeLinkCode('FAB1.x.y'), /not a FABRIC link code/);
  assert.throws(() => decodeLinkCode(code.slice(0, -4)), /damaged/);
});

test('link channel: both ends derive the same key, a third party cannot', async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const ka = await linkChannelKey(a.privateJwk, a.publicJwk, b.publicJwk);
  const kb = await linkChannelKey(b.privateJwk, b.publicJwk, a.publicJwk);
  const box = await sealJson(ka, 'L', { hi: 1 });
  assert.deepEqual(await openJson(kb, 'L', box), { hi: 1 });
  await assert.rejects(openJson(kb, 'other-label', box));
  const m = await generateIdentity();
  const km = await linkChannelKey(m.privateJwk, m.publicJwk, a.publicJwk); // relay swapping in its own key
  await assert.rejects(openJson(km, 'L', box));
  assert.ok((await ecdh(a.privateJwk, b.publicJwk)).byteLength === 32);
});

test('recovery keys and backups', async (t) => {
  const rk = newRecoveryKey();
  assert.match(rk, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(parseRecoveryKey(rk).length, 20);
  assert.deepEqual(parseRecoveryKey(rk.toLowerCase().replace(/-/g, ' ')), parseRecoveryKey(rk), 'case and spacing do not matter');
  assert.notEqual(newRecoveryKey(), rk);

  const acct = await generateSigningKey();
  const content = { v: 3, handle: H, account: acct, contacts: { '@sam.veil': { verified: true } }, threads: { '@sam.veil': [{ id: '1', text: 'hello' }] } };
  const file = await sealBackup(rk, content);
  const json = JSON.stringify(file);
  assert.ok(!json.includes('hello') && !json.includes(acct.privateJwk.d), 'nothing readable in the file');

  await t.test('restores with the right key', async () => {
    assert.deepEqual(await openBackup(rk, JSON.parse(json)), content);
  });
  await t.test('wrong key or tampering fails', async () => {
    await assert.rejects(openBackup(newRecoveryKey(), file), /Wrong recovery key/);
    const bad = JSON.parse(json);
    bad.box.ct = bad.box.ct.slice(0, -4) + 'AAAA';
    await assert.rejects(openBackup(rk, bad), /Wrong recovery key/);
    await assert.rejects(openBackup(rk, { format: 'other' }), /not a FABRIC backup/);
    assert.throws(() => parseRecoveryKey('too-short'), /32 letters/);
  });
});

test('vault: account key part is added, non-extractable, and exportable only with the passphrase', async () => {
  const vault = new Vault(memoryBackend(), { iterations: 1000 });
  await vault.create({ identity: await generateUserIdentity(), state: {}, passphrase: 'correct horse' });
  const acct = await generateSigningKey();
  const part = await vault.addIdentityPart('account', acct);
  assert.equal(part.privateKey.extractable, false);
  await assert.rejects(vault.exportIdentityPart('account', null));
  await assert.rejects(vault.exportIdentityPart('account', 'wrong one!'), /Wrong passphrase/);
  const out = await vault.exportIdentityPart('account', 'correct horse');
  assert.equal(out.privateJwk.d, acct.privateJwk.d);

  // survives a lock/unlock and a passphrase change
  vault.lock();
  const { identity } = await vault.unlock('correct horse');
  assert.ok(identity.account?.privateKey);
  await vault.setPassphrase('battery staple', 'correct horse');
  vault.lock();
  assert.ok((await vault.unlock('battery staple')).identity.account);
  await assert.rejects(vault.exportIdentityPart('sig-nope', 'battery staple'));
});
