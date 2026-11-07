import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { SessionManager, emptyStore } from '../shared/session.js';
import { signDeviceList, newDeviceId, deviceAddr } from '../shared/devices.js';
import { seal, peekSealed, openSealed, paddedLength, newDeliveryKey, isDeliveryKey } from '../shared/sealed.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
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
  const opened = new Promise((r) => ws.once('open', r));
  return { ws, next, send, ask, opened, close: () => ws.close() };
}

async function newAccount(handle) {
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), name: 'Laptop', keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle, version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: dev.name, dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  return { handle, dev, list };
}

/** A registered device with stocked prekeys. */
async function online(port, a, fetchBundle) {
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  c.send({ type: 'register', handle: a.handle, deviceId: a.dev.id, list: a.list, proof: await ownershipProof(a.dev.keys.dh.privateJwk, hello.relayKey, hello.nonce) });
  const reg = await c.next((m) => m.type === 'registered' || m.type === 'error');
  assert.equal(reg.type, 'registered', reg.error);
  const sm = new SessionManager({ handle: a.handle, deviceId: a.dev.id, identity: a.dev.keys, store: emptyStore(), fetchBundle: fetchBundle || (async (addr) => (await c.ask({ type: 'bundle', addr }, 'bundle')).bundle) });
  const count = await c.next((m) => m.type === 'prekey_count');
  const up = await sm.maintainPreKeys(count.count, { forceSpk: !count.hasSpk });
  if (up) { c.send({ type: 'upload_prekeys', ...up }); await c.next((m) => m.type === 'prekey_count'); }
  return { c, sm, deliveryKey: reg.deliveryKey };
}

const envFor = (from, to, extra = {}) => ({
  id: 'm1', from: from.handle, fromDevice: from.dev.id, to: to.handle, toDevice: to.dev.id, ts: 1, header: { dh: 'x', n: 0 }, ct: 'Y3Q=', ...extra,
});

test('sealed envelopes: only the named sender can make one, only the recipient can open it', async () => {
  const alice = await newAccount('@alice.veil');
  const bob = await newAccount('@bob.veil');
  const eve = await newAccount('@eve.veil');
  const me = deviceAddr(bob.handle, bob.dev.id);
  const bobOpen = { me, myDh: bob.dev.keys.dh.privateJwk, myDhPub: bob.dev.keys.dh.publicJwk };

  const sealed = await seal({ envelope: envFor(alice, bob), recipientDh: bob.dev.keys.dh.publicJwk, senderDh: alice.dev.keys.dh.privateJwk });
  assert.ok(!JSON.stringify(sealed).includes('alice'), 'nothing in the clear names the sender');
  const peeked = await peekSealed({ sealed, ...bobOpen });
  assert.equal(peeked.from, alice.handle);
  assert.equal(peeked.fromDevice, alice.dev.id);
  const env = await openSealed(peeked, { myDh: bob.dev.keys.dh.privateJwk, senderDh: alice.dev.keys.dh.publicJwk });
  assert.deepEqual({ ...env, sealed: undefined }, { ...envFor(alice, bob), sealed: undefined });

  // the box only opens with the claimed sender's key
  await assert.rejects(openSealed(peeked, { myDh: bob.dev.keys.dh.privateJwk, senderDh: eve.dev.keys.dh.publicJwk }));

  // Eve can't put a message under Alice's name: she can make the outer layer, not Alice's box
  const forged = await seal({ envelope: envFor(alice, bob), recipientDh: bob.dev.keys.dh.publicJwk, senderDh: eve.dev.keys.dh.privateJwk });
  const fp = await peekSealed({ sealed: forged, ...bobOpen });
  assert.equal(fp.from, alice.handle);
  await assert.rejects(openSealed(fp, { myDh: bob.dev.keys.dh.privateJwk, senderDh: alice.dev.keys.dh.publicJwk }));

  // and lifting Alice's box into a new outer layer fails too (it is bound to the ephemeral key)
  const lifted = await seal({ envelope: envFor(alice, bob), recipientDh: bob.dev.keys.dh.publicJwk, senderDh: eve.dev.keys.dh.privateJwk });
  const lp = await peekSealed({ sealed: lifted, ...bobOpen });
  await assert.rejects(openSealed({ ...lp, box: peeked.box }, { myDh: bob.dev.keys.dh.privateJwk, senderDh: alice.dev.keys.dh.publicJwk }));

  // someone else can't open it, and a flipped bit is caught
  await assert.rejects(peekSealed({ sealed, me: deviceAddr(eve.handle, eve.dev.id), myDh: eve.dev.keys.dh.privateJwk, myDhPub: eve.dev.keys.dh.publicJwk }));
  const bad = { ...sealed, ct: (sealed.ct[0] === 'A' ? 'B' : 'A') + sealed.ct.slice(1) };
  await assert.rejects(peekSealed({ sealed: bad, ...bobOpen }));
  // addressed to a different device of the same key: the recipient address is bound in
  await assert.rejects(peekSealed({ sealed, ...bobOpen, me: deviceAddr(bob.handle, 'ffffffffffffffff') }));

  // padding: short messages all come out the same size
  const short = await seal({ envelope: envFor(alice, bob, { ct: 'aGk=' }), recipientDh: bob.dev.keys.dh.publicJwk, senderDh: alice.dev.keys.dh.privateJwk });
  const longer = await seal({ envelope: envFor(alice, bob, { ct: 'a'.repeat(200) }), recipientDh: bob.dev.keys.dh.publicJwk, senderDh: alice.dev.keys.dh.privateJwk });
  assert.equal(short.ct.length, longer.ct.length);
  assert.deepEqual([1, 1024, 1025, 16384, 16385].map(paddedLength), [1024, 1024, 2048, 16384, 32768]);
  assert.ok(isDeliveryKey(newDeliveryKey()));
});

test('relay delivers sealed envelopes without learning the sender', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, sfu: null });
  t.after(() => relay.close());
  const alice = await newAccount('@alice.veil');
  const bob = await newAccount('@bob.veil');

  // Alice's anonymous socket: never registers
  const anon = client(relay.port);
  await anon.opened;
  const B = await online(relay.port, bob);
  assert.ok(isDeliveryKey(B.deliveryKey), 'own devices get the account delivery key');
  const bobAddr = deviceAddr(bob.handle, bob.dev.id);

  // prekeys anonymously: only with Bob's delivery key
  await assert.rejects(anon.ask({ type: 'bundle', addr: bobAddr, key: newDeliveryKey() }, 'bundle'), /not allowed/);
  const A = await online(relay.port, alice, async (addr) => (await anon.ask({ type: 'bundle', addr, key: B.deliveryKey }, 'bundle')).bundle);

  // a lookup works without registering
  const dir = await anon.ask({ type: 'lookup', handle: bob.handle }, 'directory');
  assert.equal(dir.list.payload.devices[0].id, bob.dev.id);

  const inner = await A.sm.encrypt(bobAddr, { kind: 'text', text: 'hi bob, sealed' });
  const sealed = await seal({ envelope: inner, recipientDh: bob.dev.keys.dh.publicJwk, senderDh: alice.dev.keys.dh.privateJwk });
  const base = { type: 'sealed_send', to: bob.handle, toDevice: bob.dev.id, id: 'outer-1', sealed };

  await assert.rejects(anon.ask({ ...base, key: newDeliveryKey() }, 'sealed_ack'), /not allowed/);
  await assert.rejects(anon.ask({ ...base, key: B.deliveryKey, toDevice: 'ffffffffffffffff' }, 'sealed_ack'), /unknown recipient/);
  await assert.rejects(anon.ask({ ...base, key: B.deliveryKey, sealed: { v: 1 } }, 'sealed_ack'), /bad envelope/);

  const ack = await anon.ask({ ...base, key: B.deliveryKey }, 'sealed_ack');
  assert.equal(ack.queued, false, 'Bob is online');
  const { envelope } = await B.c.next((m) => m.type === 'deliver');
  assert.deepEqual(Object.keys(envelope).sort(), ['id', 'sealed', 'ts']);

  // what the relay stored never names Alice
  const rows = JSON.stringify(relay.store.db.prepare('SELECT * FROM queue').all());
  assert.ok(!rows.includes('alice'), rows);

  // Bob opens it: outer layer, then the box with Alice's listed device key, then the ratchet
  const peeked = await peekSealed({ sealed: envelope.sealed, me: bobAddr, myDh: bob.dev.keys.dh.privateJwk, myDhPub: bob.dev.keys.dh.publicJwk });
  const opened = await openSealed(peeked, { myDh: bob.dev.keys.dh.privateJwk, senderDh: alice.dev.keys.dh.publicJwk });
  const payload = await B.sm.decrypt(opened, { dh: alice.dev.keys.dh.publicJwk, sig: alice.dev.keys.sig.publicJwk });
  assert.equal(payload.text, 'hi bob, sealed');

  // acked by the outer id, like any envelope
  B.c.send({ type: 'got', id: envelope.id });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.store.queueCount(bobAddr), 0);

  // rotating the key: pushed to Bob's devices, the old key stops working
  await B.c.ask({ type: 'rotate_delivery_key' }, 'delivery_key_rotated');
  const pushed = await B.c.next((m) => m.type === 'delivery_key');
  assert.notEqual(pushed.key, B.deliveryKey);
  await assert.rejects(anon.ask({ ...base, id: 'outer-2', key: B.deliveryKey }, 'sealed_ack'), /not allowed/);
  await anon.ask({ ...base, id: 'outer-2', key: pushed.key }, 'sealed_ack');

  // revenue-share counting: a self-reported tally, counted only with consent
  A.c.send({ type: 'tally', n: 5 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(relay.store.counters(alice.handle), {});
  A.c.send({ type: 'consent', consent: { usage: true } });
  await A.c.next((m) => m.type === 'account');
  A.c.send({ type: 'tally', n: 5 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.store.counters(alice.handle).usage, 5);
  await assert.rejects(A.c.ask({ type: 'tally', n: 1e6 }, 'never'), /bad count/);

  anon.close(); A.c.close(); B.c.close();
});
