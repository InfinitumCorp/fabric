// Sybil resistance: each network (/24 or /48) may make only so many new addresses a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { netblock, isLoopback } from '../server/netblock.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { signDeviceList, newDeviceId } from '../shared/devices.js';

test('netblock: IPv4 /24, IPv6 /48, mapped and loopback', () => {
  assert.equal(netblock('203.0.113.7'), '203.0.113.0/24');
  assert.equal(netblock('::ffff:203.0.113.200'), '203.0.113.0/24');
  assert.equal(netblock('2001:db8:5:1::9'), '2001:db8:5::/48');
  assert.equal(netblock('2001:0DB8:0005:ffff:1:2:3:4'), '2001:db8:5::/48');
  assert.notEqual(netblock('2001:db8:6::1'), netblock('2001:db8:5::1'));
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('203.0.113.7'));
});

/** Make (or sign back in to) an address from a given client IP, through a trusted proxy header. */
async function register(port, handle, ip, acct = null) {
  acct ||= { key: await generateSigningKey(), dev: { id: newDeviceId(), keys: await generateUserIdentity() } };
  const { key, dev } = acct;
  const list = await signDeviceList(key.privateJwk, {
    handle, version: 1, account: key.publicJwk,
    devices: [{ id: dev.id, name: 'test', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-forwarded-for': ip } });
  const msgs = [];
  const next = (pred) => new Promise((resolve, reject) => {
    const hit = msgs.find(pred);
    if (hit) return resolve(hit);
    const on = (raw) => { const m = JSON.parse(raw); if (pred(m)) { ws.off('message', on); resolve(m); } };
    ws.on('message', on);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
  ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
  const hello = await next((m) => m.type === 'hello');
  const proof = await ownershipProof(dev.keys.dh.privateJwk, hello.relayKey, hello.nonce);
  ws.send(JSON.stringify({ type: 'register', handle, deviceId: dev.id, list, proof }));
  const res = await next((m) => m.type === 'registered' || m.type === 'error');
  ws.close();
  return { res, acct };
}

test('relay: new addresses per network per day', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, trustProxy: true, newAddressesPerDay: 2 });
  t.after(() => relay.close());
  const a = await register(relay.port, '@n1.veil', '203.0.113.5');
  assert.equal(a.res.type, 'registered');
  assert.equal((await register(relay.port, '@n2.veil', '203.0.113.6')).res.type, 'registered');
  const third = await register(relay.port, '@n3.veil', '203.0.113.99');
  assert.equal(third.res.type, 'error');
  assert.match(third.res.error, /too many new addresses from this network/);
  assert.ok(third.res.retryAfter > 0);
  // the next /24 over has its own allowance
  assert.equal((await register(relay.port, '@n4.veil', '203.0.114.5')).res.type, 'registered');
  // signing back in to an address that exists is not a new address
  assert.equal((await register(relay.port, '@n1.veil', '203.0.113.5', a.acct)).res.type, 'registered');
  // IPv6: one /48
  assert.equal((await register(relay.port, '@v1.veil', '2001:db8:5:1::1')).res.type, 'registered');
  assert.equal((await register(relay.port, '@v2.veil', '2001:db8:5:2::1')).res.type, 'registered');
  assert.equal((await register(relay.port, '@v3.veil', '2001:db8:5:3::1')).res.type, 'error');
});

test('relay: loopback is exempt, and 0 turns the cap off', async (t) => {
  const r1 = await createRelay({ port: 0, dataFile: null, log: () => {}, newAddressesPerDay: 1 });
  t.after(() => r1.close());
  for (const h of ['@l1.veil', '@l2.veil', '@l3.veil']) assert.equal((await register(r1.port, h, '198.51.100.1')).res.type, 'registered', 'proxy header not trusted: loopback');
  const r2 = await createRelay({ port: 0, dataFile: null, log: () => {}, trustProxy: true, newAddressesPerDay: 0 });
  t.after(() => r2.close());
  for (const h of ['@o1.veil', '@o2.veil', '@o3.veil']) assert.equal((await register(r2.port, h, '198.51.100.1')).res.type, 'registered');
});
