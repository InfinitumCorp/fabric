// Registration work (shared/pow.js): a new address costs a little hashing, an existing one nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { leadingZeroBits, solvePow, checkPow } from '../shared/pow.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { signDeviceList, newDeviceId } from '../shared/devices.js';

test('pow: zero bits, solving and checking', async () => {
  assert.equal(leadingZeroBits(new Uint8Array([0, 0, 0x10])), 19);
  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0, 1])), 15);
  assert.equal(leadingZeroBits(new Uint8Array([0, 0])), 16);
  const job = { nonce: 'n0nce', handle: '@ana.veil', bits: 10 };
  const counter = await solvePow(job);
  assert.equal(await checkPow({ ...job, counter }), true);
  assert.equal(await checkPow({ ...job, counter: 'x' }), false);
  assert.equal(await checkPow({ ...job, counter: undefined }), false);
  assert.equal(await checkPow({ ...job, bits: 0, counter: undefined }), true, 'off when 0');
  await assert.rejects(solvePow({ ...job, bits: 40 }), /size/);
});

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
    return new Promise((resolve, reject) => { waiters.push({ pred, resolve }); setTimeout(() => reject(new Error('timeout')), 5000); });
  };
  return { ws, next, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() };
}

async function account(handle) {
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle, version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: 'Dev', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  return { handle, dev, list };
}

/** One register attempt on a fresh connection; `pow` is a counter, or a function of the hello. */
async function tryRegister(port, a, pow) {
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  const counter = typeof pow === 'function' ? await pow(hello) : pow;
  c.send({
    type: 'register', handle: a.handle, deviceId: a.dev.id, list: a.list,
    proof: await ownershipProof(a.dev.keys.dh.privateJwk, hello.relayKey, hello.nonce),
    ...(counter !== undefined ? { pow: counter } : {}),
  });
  const res = await c.next((m) => m.type === 'registered' || m.type === 'error');
  c.close();
  return { hello, res };
}

test('relay: a new address needs the work, an existing one does not', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, registerPowBits: 12, cid: null });
  t.after(() => relay.close());
  const a = await account('@ana.veil');

  const first = await tryRegister(relay.port, a);
  assert.equal(first.hello.powBits, 12, 'hello says how much work');
  assert.equal(first.res.type, 'error');
  assert.equal(first.res.error, 'proof of work needed');
  assert.equal(first.res.powBits, 12);

  // work done for another connection's nonce, or another handle, does not count
  const stale = await solvePow({ nonce: first.hello.nonce, handle: a.handle, bits: 12 });
  assert.equal((await tryRegister(relay.port, a, stale)).res.type, 'error');
  assert.equal((await tryRegister(relay.port, a, (h) => solvePow({ nonce: h.nonce, handle: '@bob.veil', bits: 12 }))).res.type, 'error');

  const ok = await tryRegister(relay.port, a, (h) => solvePow({ nonce: h.nonce, handle: a.handle, bits: 12 }));
  assert.equal(ok.res.type, 'registered', ok.res.error);

  // the address exists now: signing in again costs nothing
  assert.equal((await tryRegister(relay.port, a)).res.type, 'registered');
});

test('relay: work can be turned off', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, registerPowBits: 0, cid: null });
  t.after(() => relay.close());
  const { hello, res } = await tryRegister(relay.port, await account('@cy.veil'));
  assert.equal(hello.powBits, undefined);
  assert.equal(res.type, 'registered');
});

test('relay: a bot device does the work for a new address by itself', async (t) => {
  const { createBotDevice, newBotState } = await import('../server/bot-device.js');
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, registerPowBits: 10, cid: null });
  t.after(() => relay.close());
  const logs = [];
  const bot = createBotDevice({ state: await newBotState('@helper.veil', 'Helper'), save: () => {}, onMessage: () => {}, log: (l) => logs.push(l) });
  t.after(() => bot.stop());
  await Promise.race([bot.start(`http://127.0.0.1:${relay.port}`), new Promise((_, no) => setTimeout(() => no(new Error(`not online: ${logs.join('; ')}`)), 8000))]);
  assert.equal(bot.online, true);
  assert.deepEqual(logs.filter((l) => /refused/.test(l)), []);
});

test('relay: Scalvs does the work for its address on a fresh database', async (t) => {
  const logs = [];
  const relay = await createRelay({
    port: 0, dataFile: null, log: (l) => logs.push(l), registerPowBits: 10, cid: null,
    scalvs: { stateFile: null, ai: { ask: async () => 'ok' } },
  });
  t.after(() => relay.close());
  for (let i = 0; i < 80 && !logs.some((l) => /\[scalvs\] online/.test(l)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.some((l) => /\[scalvs\] online/.test(l)), logs.join('\n'));
  assert.deepEqual(logs.filter((l) => /refused sign-in/.test(l)), []);
});
