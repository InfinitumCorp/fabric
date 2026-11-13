import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { generateSignedPreKey, publicPreKeys } from '../shared/ratchet.js';
import { SessionManager, emptyStore } from '../shared/session.js';
import { signDeviceList, nextDeviceList, newDeviceId, deviceAddr } from '../shared/devices.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  let closed = null;
  const closeWaiters = [];
  ws.on('close', (code) => { closed = code; for (const w of closeWaiters.splice(0)) w(code); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (pred) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for message')), 3000);
    });
  };
  let ref = 0;
  const send = (o) => ws.send(JSON.stringify(o));
  const ask = async (o, type) => {
    const r = String(++ref);
    send({ ...o, ref: r });
    const m = await next((x) => x.ref === r && (x.type === type || x.type === 'error'));
    if (m.type === 'error') throw new Error(m.error);
    return m;
  };
  const closedWith = () => (closed != null ? Promise.resolve(closed) : new Promise((r) => closeWaiters.push(r)));
  return { ws, next, send, ask, closedWith, close: () => ws.close() };
}

/** An account: the account key plus device keys, and its current signed list. */
async function newAccount(handle, names) {
  const acct = await generateSigningKey();
  const devices = [];
  for (const name of names) devices.push({ id: newDeviceId(), name, keys: await generateUserIdentity() });
  const entry = (d) => ({ id: d.id, name: d.name, dh: d.keys.dh.publicJwk, sig: d.keys.sig.publicJwk, addedAt: 1 });
  const list = await signDeviceList(acct.privateJwk, { handle, version: 1, account: acct.publicJwk, devices: devices.map(entry) });
  return { handle, acct, devices, list, entry };
}

async function register(port, handle, dev, list) {
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  const proof = await ownershipProof(dev.keys.dh.privateJwk, hello.relayKey, hello.nonce);
  c.send({ type: 'register', handle, deviceId: dev.id, list, proof });
  const res = await c.next((m) => m.type === 'registered' || m.type === 'error');
  return { c, res };
}

/** A signed-in device: relay socket + session manager that keeps its prekeys stocked. */
async function online(port, account, dev, store = emptyStore()) {
  const { c, res } = await register(port, account.handle, dev, account.list);
  assert.equal(res.type, 'registered', res.error);
  const sm = new SessionManager({
    handle: account.handle, deviceId: dev.id, identity: dev.keys, store,
    fetchBundle: async (addr) => (await c.ask({ type: 'bundle', addr }, 'bundle')).bundle,
  });
  const count = await c.next((m) => m.type === 'prekey_count');
  const up = await sm.maintainPreKeys(count.hasSpk ? count.count : 0, { forceSpk: !count.hasSpk });
  if (up) {
    c.send({ type: 'upload_prekeys', ...up });
    await c.next((m) => m.type === 'prekey_count');
  }
  return { c, sm, store, dev };
}

const pub = (d) => ({ dh: d.keys.dh.publicJwk, sig: d.keys.sig.publicJwk });

test('relay v3 end to end', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {} });
  t.after(() => relay.close());
  const port = relay.port;
  const A = '@alice.veil', B = '@bob.veil';
  const alice = await newAccount(A, ['Laptop']);
  const bob = await newAccount(B, ['Phone', 'Desktop']);
  const [aLaptop] = alice.devices;
  const [bPhone, bDesktop] = bob.devices;

  const da = await online(port, alice, aLaptop);

  await t.test('impostor cannot sign in to a device without its private key', async () => {
    const mallory = await generateUserIdentity();
    const c = client(port);
    const hello = await c.next((m) => m.type === 'hello');
    const proof = await ownershipProof(mallory.dh.privateJwk, hello.relayKey, hello.nonce);
    c.send({ type: 'register', handle: A, deviceId: aLaptop.id, list: alice.list, proof });
    assert.equal((await c.next((m) => m.type === 'error')).error, 'proof failed');
    c.close();
  });

  await t.test('a different account cannot take over a handle', async () => {
    const other = await newAccount(A, ['Evil']);
    const { c, res } = await register(port, A, other.devices[0], other.list);
    assert.equal(res.error, 'handle taken');
    c.close();
  });

  await t.test('relay refuses a signed prekey not signed by the device', async () => {
    const mallory = await generateUserIdentity();
    const forged = await generateSignedPreKey(mallory.sig.privateJwk, 99);
    da.c.send({ type: 'upload_prekeys', ...publicPreKeys(forged) });
    assert.equal((await da.c.next((m) => m.type === 'error')).error, 'bad signed prekey');
  });

  // bob's two devices register and upload prekeys, then go offline so messages queue
  const bobStores = [emptyStore(), emptyStore()];
  for (const [i, d] of [bPhone, bDesktop].entries()) (await online(port, bob, d, bobStores[i])).c.close();
  await new Promise((r) => setTimeout(r, 100));

  await t.test('lookup returns the signed list (works before registering)', async () => {
    const c = client(port);
    await c.next((m) => m.type === 'hello');
    const { list } = await c.ask({ type: 'lookup', handle: B }, 'directory');
    assert.deepEqual(list, bob.list);
    c.close();
  });

  da.c.send({ type: 'consent', consent: { usage: true } });
  await da.c.next((m) => m.type === 'account');

  // alice fans one message out to both of bob's devices; only the first copy counts
  const id = 'msg-1';
  const copies = [];
  for (const [i, d] of [bPhone, bDesktop].entries()) {
    const env = await da.sm.encrypt(deviceAddr(B, d.id), { kind: 'text', text: 'classified: launch window 0600' }, { id, ts: 1 });
    if (i === 0) env.count = true;
    copies.push(env);
  }
  assert.notEqual(copies[0].ct, copies[1].ct, 'each device gets its own ciphertext');
  for (const env of copies) {
    da.c.send({ type: 'send', envelope: env });
    const ack = await da.c.next((m) => m.type === 'ack' && m.toDevice === env.toDevice);
    assert.equal(ack.queued, true);
  }

  await t.test('relay stores only ciphertext and public keys', () => {
    const dump = JSON.stringify(relay.store.dump());
    assert.ok(!dump.includes('launch window'));
    assert.ok(!dump.includes('"d"'), 'no private key material on the relay');
  });

  await t.test('cannot send as another device', async () => {
    da.c.send({ type: 'send', envelope: { ...copies[0], id: 'forged', fromDevice: bPhone.id } });
    assert.equal((await da.c.next((m) => m.type === 'error' && m.ref === 'forged')).error, 'sender mismatch');
  });

  await t.test('cannot send to a device that is not on the list', async () => {
    da.c.send({ type: 'send', envelope: { ...copies[0], id: 'nodev', toDevice: newDeviceId() } });
    assert.equal((await da.c.next((m) => m.type === 'error' && m.ref === 'nodev')).error, 'unknown recipient device');
  });

  await t.test('metadata is counted once per message, not per device copy', () => {
    assert.deepEqual(relay.store.counters(A), { usage: 1 });
  });

  // both of bob's devices come back and read their own copy
  const dp = await online(port, bob, bPhone, bobStores[0]);
  const dd = await online(port, bob, bDesktop, bobStores[1]);
  for (const dev of [dp, dd]) {
    const { envelope } = await dev.c.next((m) => m.type === 'deliver');
    assert.equal(envelope.toDevice, dev.dev.id);
    assert.equal((await dev.sm.decrypt(envelope, pub(aLaptop))).text, 'classified: launch window 0600');
  }

  await t.test('a device cannot read the copy meant for its sibling', async () => {
    const env = await da.sm.encrypt(deviceAddr(B, bDesktop.id), { text: 'desktop only' });
    await assert.rejects(dp.sm.decrypt({ ...env, toDevice: bPhone.id }, pub(aLaptop)));
  });

  await t.test('sync copies between own devices', async () => {
    const env = await dp.sm.encrypt(deviceAddr(B, bDesktop.id), { kind: 'sync', peer: A, text: 'sent from phone' });
    dp.c.send({ type: 'send', envelope: env });
    const { envelope } = await dd.c.next((m) => m.type === 'deliver' && m.envelope.from === B);
    assert.deepEqual(await dd.sm.decrypt(envelope, pub(bPhone)), { kind: 'sync', peer: A, text: 'sent from phone' });
    await dp.c.next((m) => m.type === 'ack');
    assert.deepEqual(relay.store.counters(B), {}, 'sync copies never count');
  });

  await t.test('link mailbox carries messages between unregistered and registered sockets', async () => {
    const fresh = client(port);
    await fresh.next((m) => m.type === 'hello');
    const { id: box } = await fresh.ask({ type: 'mailbox_open' }, 'mailbox_id');
    await da.c.ask({ type: 'mailbox_send', to: box, payload: { type: 'link-hello', n: 1 } }, 'mailbox_sent');
    const got = await fresh.next((m) => m.type === 'mailbox');
    assert.deepEqual(got.payload, { type: 'link-hello', n: 1 });
    await fresh.ask({ type: 'mailbox_send', to: got.from, payload: { type: 'link-device' } }, 'mailbox_sent');
    assert.equal((await da.c.next((m) => m.type === 'mailbox')).payload.type, 'link-device');
    await assert.rejects(fresh.ask({ type: 'mailbox_send', to: 'nope-nope-nope-nope', payload: {} }, 'mailbox_sent'), /expired/);
    fresh.close();
  });

  // alice links a phone: the primary signs version 2, the new device registers with it
  const aPhone = { id: newDeviceId(), name: 'Phone', keys: await generateUserIdentity() };
  const v2 = await signDeviceList(alice.acct.privateJwk, nextDeviceList(alice.list.payload, { add: [alice.entry(aPhone)] }));

  await t.test('update_devices: only the account key, only forward', async () => {
    const other = await generateSigningKey();
    const forged = await signDeviceList(other.privateJwk, { ...v2.payload, account: other.publicJwk });
    await assert.rejects(da.c.ask({ type: 'update_devices', list: forged }, 'devices_updated'), /account key changed/);
    await assert.rejects(da.c.ask({ type: 'update_devices', list: alice.list }, 'devices_updated'), /rolled back/);
    await da.c.ask({ type: 'update_devices', list: v2 }, 'devices_updated');
    assert.equal((await da.c.next((m) => m.type === 'devices')).list.payload.version, 2);
    await assert.rejects(da.c.ask({ type: 'update_devices', list: v2 }, 'devices_updated'), /rolled back/, 'same version twice');
  });

  alice.list = v2;
  const dPhone = await online(port, alice, aPhone);

  await t.test('newly linked device can message and be messaged', async () => {
    const env = await dp.sm.encrypt(deviceAddr(A, aPhone.id), { text: 'hi new phone' });
    dp.c.send({ type: 'send', envelope: env });
    const { envelope } = await dPhone.c.next((m) => m.type === 'deliver');
    assert.equal((await dPhone.sm.decrypt(envelope, pub(bPhone))).text, 'hi new phone');
  });

  await t.test('removing a device kicks it, drops its prekeys and keeps it out', async () => {
    const v3 = await signDeviceList(alice.acct.privateJwk, nextDeviceList(v2.payload, { remove: [aPhone.id] }));
    await da.c.ask({ type: 'update_devices', list: v3 }, 'devices_updated');
    assert.equal(await dPhone.c.closedWith(), 4001);
    assert.equal(relay.store.getSpk(deviceAddr(A, aPhone.id)), null);
    assert.equal(relay.store.opkCount(deviceAddr(A, aPhone.id)), 0);
    // it cannot come back with the old list (rolled back) or the new one (not on it)
    assert.equal((await register(port, A, aPhone, v2)).res.error, 'device list rolled back');
    assert.equal((await register(port, A, aPhone, v3)).res.error, 'device not on the account');
    // and nobody can address it any more
    await assert.rejects(dp.c.ask({ type: 'bundle', addr: deviceAddr(A, aPhone.id) }, 'bundle'), /unknown device/);
    alice.list = v3;
  });

  await t.test('restore: a new device signed by the account key replaces a lost one', async () => {
    const restored = { id: newDeviceId(), name: 'New laptop', keys: await generateUserIdentity() };
    const v4 = await signDeviceList(alice.acct.privateJwk, nextDeviceList(alice.list.payload, { add: [alice.entry(restored)], remove: [aLaptop.id] }));
    alice.list = v4;
    const dr = await online(port, alice, restored);
    assert.equal(await da.c.closedWith(), 4001, 'the lost laptop is signed out');
    const { list } = await dp.c.ask({ type: 'lookup', handle: A }, 'directory');
    assert.equal(list.payload.account.x, alice.acct.publicJwk.x, 'same account key, same safety number');
    assert.deepEqual(list.payload.devices.map((d) => d.name), ['New laptop']);
    dr.c.close();
  });

  await t.test('settlement pays only participants and the ledger verifies', async () => {
    const entry = relay.settle(100);
    assert.deepEqual(entry.allocations, { [A]: 7000 });
    assert.equal(entry.fab[A], 700);
    assert.ok(relay.verifyLedger());
    const row = relay.store.db.prepare('SELECT body FROM ledger WHERE seq = 0').get();
    const set = relay.store.db.prepare('UPDATE ledger SET body = ? WHERE seq = 0');
    set.run(row.body.replace('"research":false', '"research":true')); // tamper
    assert.ok(!relay.verifyLedger());
    set.run(row.body);
    assert.ok(relay.verifyLedger());
  });

  await t.test('static server does not leak files outside public/ and shared/', async () => {
    for (const p of ['/shared/../server/relay.js', '/%2e%2e/package.json', '/../package.json']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(r.status, 404, p);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/shared/devices.js`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  });

  dp.c.close(); dd.c.close();
});
