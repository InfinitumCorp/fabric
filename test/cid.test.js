import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signData } from 'node:crypto';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { createDevIssuer } from '../server/cid-dev.js';
import { verifyIdToken } from '../server/cid.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { signDeviceList, newDeviceId } from '../shared/devices.js';

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
      setTimeout(() => reject(new Error('timeout waiting for message')), 5000);
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
  return { ws, next, send, ask, close: () => ws.close() };
}

async function newAccount(handle) {
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle, version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: 'Laptop', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  return { handle, dev, list };
}

async function register(c, a) {
  const hello = await c.next((m) => m.type === 'hello');
  c.send({ type: 'register', handle: a.handle, deviceId: a.dev.id, list: a.list, proof: await ownershipProof(a.dev.keys.dh.privateJwk, hello.relayKey, hello.nonce) });
  const m = await c.next((x) => x.type === 'registered' || x.type === 'error');
  if (m.type === 'error') throw new Error(m.error);
  return m;
}

/** What the person does in the sign-in window: pick an account (or cancel). Returns the redirect. */
async function signInWindow(authorizeUrl, accountIndex = 0) {
  const page = await fetch(authorizeUrl).then((r) => r.text());
  const id = /name="request" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(id, 'account page shown');
  const r = await fetch(new URL('/authorize/decision', authorizeUrl), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: id, account: String(accountIndex) }).toString(),
  });
  assert.equal(r.status, 302);
  return new URL(r.headers.get('location'));
}

async function signIn(c, purpose, accountIndex = 0) {
  const { state, url } = await c.ask({ type: 'cid_begin', purpose }, 'cid_started');
  const back = await signInWindow(url, accountIndex);
  assert.equal(back.searchParams.get('state'), state);
  return c.ask({ type: 'cid_finish', state, code: back.searchParams.get('code') }, 'cid_done');
}

async function setup({ required = false } = {}) {
  const clients = { 'fabric-dev': { redirects: [] } };
  const dev = createDevIssuer({ port: 0, clients });
  await dev.listen();
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, sfu: null, phone: null, cid: { issuer: dev.issuer, clientId: 'fabric-dev', required } });
  clients['fabric-dev'].redirects.push(`http://localhost:${relay.port}/cid-callback.html`);
  return { dev, relay, close: async () => { await relay.close(); await dev.close(); } };
}

const backupFor = (handle) => ({ format: 'fabric-backup', v: 3, createdAt: new Date().toISOString(), handle, salt: 'c2FsdA==', box: { iv: 'aXY=', ct: 'Y3Q=' } });

test('link a CID, save a backup to Cumulus, find it again on a new device', async () => {
  const env = await setup();
  const base = `http://127.0.0.1:${env.relay.port}`;
  try {
    assert.deepEqual(await fetch(`${base}/api/cid`).then((r) => r.json()), { enabled: true, required: false });
    const amy = await newAccount('@amy.veil');
    const c = client(env.relay.port);
    await register(c, amy);
    assert.equal((await c.next((m) => m.type === 'cid_status')).linked, false);

    const done = await signIn(c, 'link', 0);
    assert.equal(done.email, 'alex@cumulusmail.cloud');
    const st = await c.next((m) => m.type === 'cid_status' && m.linked);
    assert.equal(st.backup, null);
    // the relay keeps a keyed hash, not CID's id or the email
    const row = env.relay.store.db.prepare('SELECT key, handle FROM cid_links').get();
    assert.equal(row.handle, '@amy.veil');
    assert.ok(!JSON.stringify(row).includes('alex'));

    const { ticket } = await c.ask({ type: 'cid_backup_ticket' }, 'cid_backup_ticket');
    const put = await fetch(`${base}/api/cid/backup?ticket=${ticket}`, { method: 'PUT', body: JSON.stringify(backupFor('@amy.veil')) });
    assert.equal(put.status, 200);
    const again = await fetch(`${base}/api/cid/backup?ticket=${ticket}`, { method: 'PUT', body: JSON.stringify(backupFor('@amy.veil')) });
    assert.equal(again.status, 403, 'tickets are one use');
    const t2 = (await c.ask({ type: 'cid_backup_ticket' }, 'cid_backup_ticket')).ticket;
    assert.equal((await fetch(`${base}/api/cid/backup?ticket=${t2}`, { method: 'PUT', body: JSON.stringify(backupFor('@ben.veil')) })).status, 400, 'only this account’s backup');

    // a new device, not registered: sign in with the same CID
    const fresh = client(env.relay.port);
    await fresh.next((m) => m.type === 'hello');
    const r = await signIn(fresh, 'restore', 0);
    assert.equal(r.handle, '@amy.veil');
    const file = await fetch(`${base}/api/cid/backup?ticket=${r.backup.ticket}`).then((x) => x.json());
    assert.deepEqual(file.box, backupFor('@amy.veil').box);
    assert.equal((await fetch(`${base}/api/cid/backup?ticket=${r.backup.ticket}`)).status, 404, 'download tickets are one use');

    // another CID finds nothing
    assert.equal((await signIn(fresh, 'restore', 1)).handle, null);

    // unlinking deletes the cloud backup
    await c.ask({ type: 'cid_unlink' }, 'cid_unlinked');
    assert.equal((await signIn(fresh, 'restore', 0)).handle, null);
    assert.equal(env.relay.store.getBackup('@amy.veil'), null);
    c.close(); fresh.close();
  } finally { await env.close(); }
});

test('a sign-in finishes only on the socket that started it, once; codes need the PKCE verifier', async () => {
  const env = await setup();
  try {
    const a = client(env.relay.port);
    const b = client(env.relay.port);
    await a.next((m) => m.type === 'hello');
    await b.next((m) => m.type === 'hello');
    const { state, url } = await a.ask({ type: 'cid_begin', purpose: 'restore' }, 'cid_started');
    const back = await signInWindow(url);
    const code = back.searchParams.get('code');
    // someone else's socket (an attacker who got the code) is refused; the real one still finishes
    await assert.rejects(b.ask({ type: 'cid_finish', state, code }, 'cid_done'), /not started here/);
    await a.ask({ type: 'cid_finish', state, code }, 'cid_done');
    await assert.rejects(a.ask({ type: 'cid_finish', state, code }, 'cid_done'), /not started here/);

    // the issuer refuses a code without the right verifier (and then refuses it for good)
    const { url: url2 } = await a.ask({ type: 'cid_begin', purpose: 'restore' }, 'cid_started');
    const back2 = await signInWindow(url2);
    const u2 = new URL(url2);
    const tok = await fetch(new URL('/token', env.dev.issuer), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back2.searchParams.get('code'), client_id: 'fabric-dev', redirect_uri: u2.searchParams.get('redirect_uri'), code_verifier: 'x'.repeat(43) }).toString(),
    }).then((r) => r.json());
    assert.equal(tok.error, 'invalid_grant');
    await assert.rejects(a.ask({ type: 'cid_finish', state: back2.searchParams.get('state'), code: back2.searchParams.get('code') }, 'cid_done'), /code unknown, used or expired/);

    // the issuer never redirects to an unregistered address
    const evil = new URL(url2);
    evil.searchParams.set('redirect_uri', 'https://evil.example/cb');
    assert.equal((await fetch(evil)).status, 400);
    a.close(); b.close();
  } finally { await env.close(); }
});

test('FABRIC_CID_REQUIRED: a new address needs a CID without one; existing addresses are unaffected', async () => {
  const env = await setup({ required: true });
  try {
    const amy = await newAccount('@amy.veil');
    const c1 = client(env.relay.port);
    await assert.rejects(register(c1, amy), /Sign in with Cumulus:\/\/ID first/);
    c1.close();

    // a sign-in on another socket doesn't count: the proof belongs to the socket it finished on
    const c2 = client(env.relay.port);
    await c2.next((m) => m.type === 'hello');
    assert.equal((await signIn(c2, 'register', 0)).email, 'alex@cumulusmail.cloud');
    await assert.rejects(register(client(env.relay.port), amy), /Sign in with Cumulus:\/\/ID first/);
    c2.close();

    // sign in, then register, on one socket
    const c3 = client(env.relay.port);
    const h3 = await c3.next((m) => m.type === 'hello');
    await signIn(c3, 'register', 1);
    c3.send({ type: 'register', handle: amy.handle, deviceId: amy.dev.id, list: amy.list, proof: await ownershipProof(amy.dev.keys.dh.privateJwk, h3.relayKey, h3.nonce) });
    assert.equal((await c3.next((m) => m.type === 'registered' || m.type === 'error')).type, 'registered');
    assert.equal((await c3.next((m) => m.type === 'cid_status')).linked, true, 'linked at registration');
    c3.close();

    // that CID can't start a second address
    const c4 = client(env.relay.port);
    await c4.next((m) => m.type === 'hello');
    await assert.rejects(signIn(c4, 'register', 1), /already has a FabriC\+\+ address/);
    c4.close();

    // the existing address signs in again without a CID
    const c5 = client(env.relay.port);
    await register(c5, amy);
    c5.close();
  } finally { await env.close(); }
});

test('ID tokens: signature, algorithm, issuer, audience, time and nonce are all checked', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const good = { iss: 'https://id.cumulus.test', aud: 'fabric', sub: 'u1', exp: t + 300, iat: t, nonce: 'n1' };
  const make = (claims, { header = { alg: 'ES256', kid: 'k1' }, key = privateKey } = {}) => {
    const h = enc(header); const p = enc(claims);
    const sig = header.alg === 'ES256' ? signData('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url') : '';
    return `${h}.${p}.${sig}`;
  };
  const opts = { issuer: good.iss, clientId: 'fabric', nonce: 'n1', keys: async (kid) => (kid === 'k1' ? jwk : null), now };
  assert.equal((await verifyIdToken(make(good), opts)).sub, 'u1');
  await assert.rejects(verifyIdToken(make(good, { header: { alg: 'none', kid: 'k1' } }), opts), /not allowed/);
  await assert.rejects(verifyIdToken(make(good, { header: { alg: 'HS256', kid: 'k1' } }), opts), /not allowed/);
  await assert.rejects(verifyIdToken(make(good, { key: other.privateKey }), opts), /bad token signature/);
  await assert.rejects(verifyIdToken(make(good, { header: { alg: 'ES256', kid: 'nope' } }), opts), /unknown signing key/);
  const [h, , sig] = make(good).split('.');
  await assert.rejects(verifyIdToken(`${h}.${enc({ ...good, sub: 'u2' })}.${sig}`, opts), /bad token signature/, 'tampered claims');
  await assert.rejects(verifyIdToken(make({ ...good, iss: 'https://evil.test' }), opts), /another issuer/);
  await assert.rejects(verifyIdToken(make({ ...good, aud: 'other' }), opts), /another client/);
  await assert.rejects(verifyIdToken(make({ ...good, aud: ['fabric', 'other'] }), opts), /another client/, 'several audiences need azp');
  assert.ok(await verifyIdToken(make({ ...good, aud: ['fabric', 'other'], azp: 'fabric' }), opts));
  await assert.rejects(verifyIdToken(make({ ...good, exp: t - 120 }), opts), /expired/);
  await assert.rejects(verifyIdToken(make({ ...good, nonce: 'n2' }), opts), /nonce/);
  await assert.rejects(verifyIdToken(make({ ...good, sub: '' }), opts), /no subject/);
});
