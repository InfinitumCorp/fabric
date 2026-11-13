import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { openStore } from '../server/store.js';
import { Buckets, defaultLimits } from '../server/limits.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { SessionManager, emptyStore } from '../shared/session.js';
import { signDeviceList, newDeviceId, deviceAddr } from '../shared/devices.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-test-'));
const quiet = { log: () => {} };

function client(port, { origin } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (pred, ms = 3000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for message')), ms);
    });
  };
  const none = async (pred, ms = 300) => {
    await new Promise((r) => setTimeout(r, ms));
    return !inbox.some(pred);
  };
  let ref = 0;
  const send = (o) => ws.send(JSON.stringify(o));
  const ask = async (o, type) => {
    const r = String(++ref);
    send({ ...o, ref: r });
    const m = await next((x) => x.ref === r && (x.type === type || x.type === 'error'));
    if (m.type === 'error') throw Object.assign(new Error(m.error), { msg: m });
    return m;
  };
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', (_, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode }))); ws.once('error', () => {}); });
  return { ws, next, none, send, ask, opened, inbox, close: () => ws.close() };
}

async function account(handle) {
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle, version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: 'Dev', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  return { handle, acct, dev, list, addr: deviceAddr(handle, dev.id) };
}

/** Register a device; optionally upload prekeys. Returns { c, sm }. */
async function signIn(port, a, { prekeys = true, store = a.store ??= emptyStore() } = {}) {
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  c.send({ type: 'register', handle: a.handle, deviceId: a.dev.id, list: a.list, proof: await ownershipProof(a.dev.keys.dh.privateJwk, hello.relayKey, hello.nonce) });
  const res = await c.next((m) => m.type === 'registered' || m.type === 'error');
  assert.equal(res.type, 'registered', res.error);
  const sm = new SessionManager({
    handle: a.handle, deviceId: a.dev.id, identity: a.dev.keys, store,
    fetchBundle: async (addr) => (await c.ask({ type: 'bundle', addr }, 'bundle')).bundle,
  });
  const count = await c.next((m) => m.type === 'prekey_count');
  if (prekeys) {
    const up = await sm.maintainPreKeys(count.hasSpk ? count.count : 0, { forceSpk: !count.hasSpk });
    if (up) { c.send({ type: 'upload_prekeys', ...up }); await c.next((m) => m.type === 'prekey_count'); }
  }
  return { c, sm };
}

const pub = (a) => ({ dh: a.dev.keys.dh.publicJwk, sig: a.dev.keys.sig.publicJwk });

test('store: committed to disk, survives reopen, dedupes and caps queues', () => {
  const file = path.join(tmp(), 'fabric.db');
  let s = openStore(file);
  const env = (id) => ({ id, from: '@a.veil', to: '@b.veil', ct: 'x' });
  assert.equal(s.enqueue('@b.veil#1', env('m1'), 2), 'queued');
  assert.equal(s.enqueue('@b.veil#1', env('m1'), 2), 'duplicate', 'a resend is stored once');
  assert.equal(s.enqueue('@b.veil#1', env('m2'), 2), 'queued');
  assert.equal(s.enqueue('@b.veil#1', env('m3'), 2), 'full');
  s.appendLedger({ kind: 'consent', handle: '@a.veil', consent: { usage: true } });
  s.close();

  s = openStore(file); // as after a crash or restart
  assert.deepEqual(s.queued('@b.veil#1').map((e) => e.id), ['m1', 'm2']);
  assert.equal(s.ack('@b.veil#1', 'm1'), 1);
  assert.deepEqual(s.queued('@b.veil#1').map((e) => e.id), ['m2']);
  assert.ok(s.verifyLedger());
  assert.equal(s.receipts('@a.veil').length, 1);

  assert.equal(s.expireQueues(Date.now() + 1), 1, 'old envelopes expire');
  assert.equal(s.queueCount('@b.veil#1'), 0);

  // a failed transaction leaves nothing behind
  assert.throws(() => s.tx(() => { s.setConsent('@c.veil', { usage: true }); throw new Error('boom'); }));
  assert.equal(s.getConsent('@c.veil'), null);
  s.close();
});

test('store: revenue-share counters are capped per day', () => {
  const s = openStore(null);
  const day1 = Date.UTC(2026, 10, 5, 12);
  assert.equal(s.bump('@a.veil', 'research', 2, 3, day1), 2);
  assert.equal(s.bump('@a.veil', 'research', 5, 3, day1), 1, 'only up to the cap');
  assert.equal(s.bump('@a.veil', 'research', 1, 3, day1), 0);
  assert.equal(s.bump('@a.veil', 'research', 1, 3, day1 + 86400_000), 1, 'next day counts again');
  assert.deepEqual(s.counters('@a.veil'), { research: 4 });
  s.close();
});

test('store: imports the old JSON state once, ledger intact', async () => {
  const dir = tmp();
  const legacy = path.join(dir, 'state-v3.json');
  const a = await account('@old.veil');
  const s0 = openStore(null);
  const e0 = s0.appendLedger({ kind: 'consent', handle: a.handle, consent: { usage: true } });
  fs.writeFileSync(legacy, JSON.stringify({
    directory: { [a.handle]: { account: a.acct.publicJwk, list: a.list } },
    prekeys: {}, queues: { [a.addr]: [{ id: 'q1', from: '@x.veil', ct: 'c' }] },
    consent: { [a.handle]: { usage: true } }, counters: { [a.handle]: { usage: 7 } }, balances: { [a.handle]: 3 },
    ledger: [(() => { const { hash, ...b } = e0; return { ...b, hash }; })()],
  }));
  const s = openStore(path.join(dir, 'fabric.db'), { importJson: legacy });
  assert.deepEqual(s.getList(a.handle), a.list);
  assert.equal(s.queueCount(a.addr), 1);
  assert.deepEqual(s.counters(a.handle), { usage: 7 });
  assert.equal(s.balance(a.handle), 3);
  assert.ok(s.verifyLedger(), 'same hashes after import');
  assert.ok(!fs.existsSync(legacy) && fs.existsSync(legacy + '.imported'));
  s.close(); s0.close();
});

test('delivery: stored until the device acknowledges it, across reconnects and restarts', async () => {
  const dataFile = path.join(tmp(), 'fabric.db');
  let relay = await createRelay({ port: 0, dataFile, ...quiet });
  const alice = await account('@alice.veil');
  const bob = await account('@bob.veil');
  const b1 = await signIn(relay.port, bob);
  const a1 = await signIn(relay.port, alice);

  const env = await a1.sm.encrypt(bob.addr, { kind: 'text', text: 'keep me' });
  a1.c.send({ type: 'send', envelope: env });
  assert.equal((await a1.c.next((m) => m.type === 'ack')).queued, false, 'delivered live');
  await b1.c.next((m) => m.type === 'deliver');
  // bob's socket dies before he saved and acknowledged it
  b1.c.ws.terminate();
  await new Promise((r) => setTimeout(r, 100));

  // the relay restarts too
  a1.c.close();
  await relay.close();
  relay = await createRelay({ port: 0, dataFile, ...quiet });

  const b2 = await signIn(relay.port, bob, { prekeys: false });
  const { envelope } = await b2.c.next((m) => m.type === 'deliver');
  assert.equal((await b2.sm.decrypt(envelope, pub(alice))).text, 'keep me');
  b2.c.send({ type: 'got', id: envelope.id });
  await new Promise((r) => setTimeout(r, 100));
  b2.c.close();

  const b3 = await signIn(relay.port, bob, { prekeys: false });
  assert.ok(await b3.c.none((m) => m.type === 'deliver'), 'not delivered again after the ack');
  b3.c.close();
  await relay.close();
});

test('abuse limits', async (t) => {
  const limits = defaultLimits();
  limits.send = new Buckets(3, 0.001);
  limits.opkTarget = new Buckets(3, 0.001);
  const relay = await createRelay({ port: 0, dataFile: null, limits, ...quiet });
  t.after(() => relay.close());
  const target = await account('@target.veil');
  const t1 = await signIn(relay.port, target);
  const opksAtStart = relay.store.opkCount(target.addr);

  await t.test('one requester cannot drain one-time prekeys', async () => {
    const m = await account('@mallory.veil');
    const mc = await signIn(relay.port, m);
    const got = [];
    for (let i = 0; i < 6; i++) got.push((await mc.c.ask({ type: 'bundle', addr: target.addr }, 'bundle')).bundle.opk);
    assert.equal(got.filter(Boolean).length, 2, 'two per pair, then bundles without one');
    assert.ok(got.every((b, i) => (i < 2 ? b : b === null)));
    mc.c.close();
  });

  await t.test('many requesters together are capped per target', async () => {
    let handed = 0;
    for (let i = 0; i < 3; i++) {
      const s = await account(`@sybil${i}.veil`);
      const sc = await signIn(relay.port, s, { prekeys: false });
      if ((await sc.c.ask({ type: 'bundle', addr: target.addr }, 'bundle')).bundle.opk) handed++;
      sc.c.close();
    }
    assert.equal(handed, 1, 'target budget of 3 was already 2/3 used');
    assert.equal(relay.store.opkCount(target.addr), opksAtStart - 3);
  });

  const p = await account('@peer.veil');
  const pc = await signIn(relay.port, p);

  await t.test('a bundle without a one-time prekey still sets up a working session', async () => {
    const env = await pc.sm.encrypt(target.addr, { kind: 'text', text: 'no opk needed' });
    assert.equal(env.header.pre.opkId ?? null, null);
    assert.equal((await t1.sm.decrypt(env, pub(p))).text, 'no opk needed');
  });

  await t.test('sending is rate limited per device', async () => {
      const errs = [];
      for (let i = 0; i < 5; i++) {
        const e = await pc.sm.encrypt(target.addr, { kind: 'text', text: String(i) });
        pc.c.send({ type: 'send', envelope: e });
        const m = await pc.c.next((x) => (x.type === 'ack' || x.type === 'error') && (x.id === e.id || x.ref === e.id));
        if (m.type === 'error') errs.push(m);
      }
      assert.equal(errs.length, 2, 'bucket of 3: three go through, the rest are refused');
      assert.equal(errs[0].error, 'rate limited');
      assert.ok(errs[0].retryAfter > 0);
      assert.equal(errs[0].toDevice, target.dev.id, 'the client can mark that copy failed');
  });
  pc.c.close();

  await t.test('garbage does not take the relay down', async () => {
    const c = client(relay.port);
    await c.next((m) => m.type === 'hello');
    const junk = ['nope', '[]', 'null', '{"type":"register","list":{"payload":null}}', '{"type":"register","handle":"@x.veil","deviceId":"0123456789abcdef","list":{"payload":{"v":3,"handle":"@x.veil","account":{},"devices":[]}}}', '{"type":"bundle"}', '{"type":"send"}', '{"type":"lookup","handle":{"a":1}}', '{"type":"mailbox_send","to":{},"payload":1}'];
    for (const j of junk) c.ws.send(j);
    const replies = [];
    for (let i = 0; i < junk.length; i++) replies.push((await c.next((m) => m.type === 'error')).error);
    assert.ok(!replies.includes('internal error'), `typed input is rejected cleanly: ${replies}`);
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/api/health`)).status, 200);
    c.close();
  });
  t1.c.close();
});

test('operator endpoints and metadata', async (t) => {
  const operatorToken = 'op-' + 'x'.repeat(40);
  const relay = await createRelay({ port: 0, dataFile: null, operatorToken, ...quiet });
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.port}`;
  const a = await account('@earner.veil');
  const ac = await signIn(relay.port, a, { prekeys: false });
  ac.c.send({ type: 'consent', consent: { research: true } });
  await ac.c.next((m) => m.type === 'account');
  ac.c.send({ type: 'feature', feature: 'summary' });

  await t.test('settlement needs the operator token, even from localhost', async () => {
    const post = (headers = {}, body = '{"revenue":100}') => fetch(`${base}/api/economy/settle`, { method: 'POST', headers, body });
    assert.equal((await post()).status, 403);
    assert.equal((await post({ authorization: 'Bearer wrong' })).status, 403);
    const ok = await post({ authorization: `Bearer ${operatorToken}` });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).allocations, { [a.handle]: 7000 });
    assert.equal((await post({ authorization: `Bearer ${operatorToken}` }, '{bad')).status, 400);
    assert.equal((await post({ authorization: `Bearer ${operatorToken}` }, 'x'.repeat(20_000))).status, 413);
  });

  await t.test('public endpoints show totals, not who earns what', async () => {
    const preview = await (await fetch(`${base}/api/economy/preview?revenue=100`)).json();
    assert.equal(preview.poolCents, 7000);
    assert.equal(preview.allocations, undefined);
    const ledger = await (await fetch(`${base}/api/ledger`)).json();
    assert.equal(ledger.valid, true);
    assert.equal(ledger.length, 2);
    assert.equal(ledger.entries, undefined, 'consent receipts name users');
    const op = await (await fetch(`${base}/api/ledger`, { headers: { authorization: `Bearer ${operatorToken}` } })).json();
    assert.equal(op.entries.length, 2);
  });

  await t.test('a user sees their own allocation over their socket', async () => {
    const p = await ac.c.ask({ type: 'preview', revenue: 100 }, 'preview');
    assert.equal(p.mineCents, 7000);
    assert.equal(p.allocations, undefined);
  });
  ac.c.close();
});

test('without a token, forwarded requests are never treated as local', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, operatorToken: null, ...quiet });
  t.after(() => relay.close());
  const post = (headers) => fetch(`http://127.0.0.1:${relay.port}/api/economy/settle`, { method: 'POST', headers, body: '{"revenue":1}' });
  assert.equal((await post({ 'x-forwarded-for': '203.0.113.9' })).status, 403);
  assert.equal((await post({})).status, 200);
});

test('websocket origin check and connection limits', async (t) => {
  const limits = defaultLimits();
  limits.connectIp = new Buckets(3, 0.001); // the rejected origin never takes a token
  const relay = await createRelay({ port: 0, dataFile: null, limits, ...quiet });
  t.after(() => relay.close());
  const evil = client(relay.port, { origin: 'https://evil.example' });
  await assert.rejects(evil.opened, (e) => e.status === 403);
  const same = client(relay.port, { origin: `http://127.0.0.1:${relay.port}` });
  await same.opened;
  const extra = [client(relay.port), client(relay.port)];
  await Promise.all(extra.map((c) => c.opened));
  const over = client(relay.port);
  await assert.rejects(over.opened, (e) => e.status === 429);
  for (const c of [same, ...extra]) c.close();
});

test('rate-limited HTTP API', async (t) => {
  const limits = defaultLimits();
  limits.httpIp = new Buckets(3, 0.001);
  const relay = await createRelay({ port: 0, dataFile: null, limits, ...quiet });
  t.after(() => relay.close());
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`http://127.0.0.1:${relay.port}/api/health`)).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/`)).status, 200, 'static files are not limited');
});

let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }

test('TLS with HSTS', { skip: !hasOpenssl && 'openssl not installed' }, async (t) => {
  const dir = tmp();
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const relay = await createRelay({ port: 0, dataFile: null, tls: { cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, ...quiet });
  t.after(() => relay.close());
  const res = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: relay.port, path: '/api/health', ca: fs.readFileSync(cert), servername: 'localhost' }, resolve).on('error', reject);
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['strict-transport-security'], /max-age=31536000/);
  res.resume();
  assert.ok(relay.url.startsWith('https://'));
});
