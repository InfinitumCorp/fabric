import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createRelay } from '../server/relay.js';
import { runTask, calc, parseDuration, fmtDuration, MAX_REMINDERS } from '../server/scalvs-tasks.js';
import { createAi } from '../server/scalvs-ai.js';
import { SCALVS_HANDLE } from '../server/scalvs.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { SessionManager, emptyStore } from '../shared/session.js';
import { signDeviceList, newDeviceId, deviceAddr, findDevice } from '../shared/devices.js';
import { seal } from '../shared/sealed.js';

// ---------- task engine ----------
function reminders() {
  const list = [];
  return { list: () => list, add: (at, text) => list.push({ at, text }), clear: () => list.splice(0).length };
}
const ctx = (extra = {}) => ({ handle: '@amy.veil', now: 0, reminders: reminders(), ai: null, ...extra });

test('calc: arithmetic without eval, precedence, functions, nothing else', () => {
  assert.equal(calc('2+3*4'), 14);
  assert.equal(calc('2*(3+4)^2'), 98);
  assert.equal(calc('2^3^2'), 512, 'right-associative powers');
  assert.equal(calc('-2^2'), -4);
  assert.equal(calc('sqrt(16) + abs(-3)'), 7);
  assert.equal(calc('10 % 4'), 2);
  assert.equal(calc('1,000 * 3'), 3000);
  assert.equal(calc('6 × 7 ÷ 2'), 21);
  assert.ok(Math.abs(calc('pi') - Math.PI) < 1e-12);
  for (const bad of ['process.exit()', '2+', '(1', 'constructor', '1/0', 'alert(1)', '']) assert.throws(() => calc(bad), bad);
  assert.throws(() => calc('('.repeat(150) + '1' + ')'.repeat(150)), 'deep nesting is refused');
});

test('durations: units, words, combinations', () => {
  assert.deepEqual(parseDuration('20m to call Ana'), { ms: 20 * 60_000, rest: 'to call ana' });
  assert.equal(parseDuration('1h30m stretch').ms, 90 * 60_000);
  assert.equal(parseDuration('2 hours and 5 minutes x').ms, (125) * 60_000);
  assert.equal(parseDuration('call Ana'), null);
  assert.equal(fmtDuration(90 * 60_000 + 5000), '1h 30m 5s');
});

test('tasks: built-ins run here, unknown ones go to the AI hook only when there is one', async () => {
  assert.equal((await runTask('calc 2+2', ctx())).reply, '2+2 = 4');
  assert.equal((await runTask('7*6', ctx())).reply, '7*6 = 42', 'a bare sum is a calc task');
  assert.equal((await runTask('/ping', ctx())).reply, 'pong');
  assert.match((await runTask('time UTC', ctx())).reply, /1970/);
  assert.match((await runTask('time Not/AZone', ctx())).reply, /don't know the time zone/);
  assert.match((await runTask('roll 3d6', ctx())).reply, /^🎲 \d+ \+ \d+ \+ \d+ = \d+$/);
  assert.match((await runTask('uuid', ctx())).reply, /^[0-9a-f-]{36}$/);
  assert.equal((await runTask('password 32', ctx())).reply.length, 32);
  const help = (await runTask('help', ctx())).reply;
  assert.match(help, /calc/);
  assert.doesNotMatch(help, /Anthropic/, 'no AI note when AI tasks are off');
  assert.match((await runTask('help', ctx({ ai: async () => '' }))).reply, /Anthropic/, 'the AI note says where AI tasks go');

  const off = await runTask('write a haiku about rain', ctx());
  assert.equal(off.kind, 'unknown');
  const asked = [];
  const on = await runTask('write a haiku about rain', ctx({ ai: async (t) => { asked.push(t); return 'Rain on the window'; } }));
  assert.deepEqual(on, { reply: 'Rain on the window', kind: 'ai' });
  assert.deepEqual(asked, ['write a haiku about rain']);
  const failed = await runTask('plan my week', ctx({ ai: async () => { throw new Error('boom'); } }));
  assert.equal(failed.kind, 'ai_error');
  assert.doesNotMatch(failed.reply, /boom/, 'internal errors are not shown');

  // model output is cleaned like everything else that reaches the page
  assert.equal((await runTask('x?', ctx({ ai: async () => 'ok‮ evil\u0007' }))).reply, 'ok evil');
});

test('reminders: set, list, cancel, limits', async () => {
  const c = ctx({ now: 1000 });
  assert.match((await runTask('remind me in 20m to call Ana', c)).reply, /in 20m I'll remind you: call Ana/);
  assert.deepEqual(c.reminders.list(), [{ at: 1000 + 20 * 60_000, text: 'call Ana' }]);
  assert.match((await runTask('reminders', c)).reply, /in 20m: call Ana/);
  assert.match((await runTask('remind me in 8 days to x', c)).reply, /up to 7 days/);
  assert.match((await runTask('remind me to x', c)).reply, /Try:/);
  for (let i = 1; i < MAX_REMINDERS; i++) await runTask(`remind ${i}m x`, c);
  assert.match((await runTask('remind 5m one too many', c)).reply, /already have/);
  assert.equal((await runTask('cancel reminders', c)).reply, `Cancelled ${MAX_REMINDERS} reminders.`);
});

test('AI tasks: one Claude call each, chat history resent unchanged, daily cap, refusals', async () => {
  const calls = [];
  let answer = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Sure.' }] };
  const client = { beta: { messages: { create: async (req) => { calls.push(structuredClone(req)); return answer; } } } };
  let t = 0;
  const ai = createAi({ client, dailyPerUser: 3, now: () => t, log: () => {} });
  assert.equal(await ai.ask('@amy.veil', 'hello'), 'Sure.');
  assert.equal(await ai.ask('@amy.veil', 'and then?'), 'Sure.');
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].fallbacks, 'default');
  assert.deepEqual(calls[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(calls[1].messages[1].content, answer.content, 'the assistant turn is replayed as returned (thinking included)');
  assert.equal((await ai.ask('@ben.veil', 'hi'), calls[2].messages.length), 1, 'chats are per person');
  answer = { stop_reason: 'refusal', content: [] };
  assert.match(await ai.ask('@amy.veil', 'x'), /can't help/);
  await assert.rejects(ai.ask('@amy.veil', 'over the cap'), (e) => /today's 3 AI tasks/.test(e.userMessage));
  t += 24 * 3600_000;
  answer = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'New day.' }] };
  assert.equal(await ai.ask('@amy.veil', 'again'), 'New day.');
  assert.equal(calls.at(-1).messages.length, 1, 'an idle chat starts over');
});

// ---------- end to end over a relay ----------
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (pred, ms = 5000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); reject(new Error('timeout waiting for message')); } }, ms);
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

async function signIn(port, a) {
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  c.send({ type: 'register', handle: a.handle, deviceId: a.dev.id, list: a.list, proof: await ownershipProof(a.dev.keys.dh.privateJwk, hello.relayKey, hello.nonce) });
  const reg = await c.next((m) => m.type === 'registered' || m.type === 'error');
  if (reg.type === 'error') return { c, error: reg.error };
  const sm = new SessionManager({ handle: a.handle, deviceId: a.dev.id, identity: a.dev.keys, store: a.store ??= emptyStore(), fetchBundle: async (addr) => (await c.ask({ type: 'bundle', addr }, 'bundle')).bundle });
  const count = await c.next((m) => m.type === 'prekey_count');
  const up = await sm.maintainPreKeys(count.count, { forceSpk: !count.hasSpk });
  if (up) { c.send({ type: 'upload_prekeys', ...up }); await c.next((m) => m.type === 'prekey_count'); }
  return { c, sm };
}

/** What the browser does: text to every device of +scalvs, then read deliveries until a text comes back. */
async function textScalvs(port, me, text, { sealedWith = null } = {}) {
  const { c, sm } = me.session;
  const { list } = await c.ask({ type: 'lookup', handle: SCALVS_HANDLE }, 'directory');
  for (const d of list.payload.devices) {
    const env = await sm.encrypt(deviceAddr(SCALVS_HANDLE, d.id), { kind: 'text', text });
    if (sealedWith) {
      const sealed = await seal({ envelope: env, recipientDh: d.dh, senderDh: me.dev.keys.dh.privateJwk });
      await c.ask({ type: 'sealed_send', to: SCALVS_HANDLE, toDevice: d.id, key: sealedWith, id: env.id + 's', sealed }, 'sealed_ack');
    } else {
      c.send({ type: 'send', envelope: env });
      await c.next((m) => m.type === 'ack' && m.id === env.id);
    }
  }
  const kinds = [];
  for (;;) {
    const { envelope } = await c.next((m) => m.type === 'deliver');
    assert.equal(envelope.from, SCALVS_HANDLE);
    const dev = findDevice(list.payload, envelope.fromDevice);
    const payload = await sm.decrypt(envelope, { dh: dev.dh, sig: dev.sig });
    c.send({ type: 'got', id: envelope.id });
    kinds.push(payload.kind);
    if (payload.kind === 'text') return { ...payload, kinds };
  }
}

test('Scalvs end to end: text +scalvs, it runs the task and replies, end-to-end encrypted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalvs-'));
  const stateFile = path.join(dir, 'scalvs.json');
  const asked = [];
  const ai = { ask: async (handle, text) => { asked.push([handle, text]); return `AI did: ${text}`; } };
  let relay = await createRelay({ port: 0, dataFile: path.join(dir, 'fabric.db'), log: () => {}, scalvs: { stateFile, ai } });
  t.after(async () => { await relay.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await relay.scalvsReady;
  const port = relay.port;

  const status = await (await fetch(`${relay.url}/api/scalvs`)).json();
  assert.deepEqual(status, { enabled: true, handle: SCALVS_HANDLE, ai: true });

  const amy = await newAccount('@amy.veil');
  amy.session = await signIn(port, amy);

  await t.test('a built-in task: reply in the same thread, with a read receipt and typing first', async () => {
    const r = await textScalvs(port, amy, 'calc 2*(3+4)');
    assert.equal(r.text, '2*(3+4) = 14');
    assert.deepEqual(r.kinds, ['receipt', 'typing', 'text']);
    assert.match(r.dk, /^[A-Za-z0-9_-]{22}$/, 'Scalvs hands out its delivery key, so the app can send to it sealed');
    amy.scalvsKey = r.dk;
  });

  await t.test('an AI task goes to the AI hook with who asked; the relay never sees the text', async () => {
    const r = await textScalvs(port, amy, 'summarise: the meeting moved to Friday');
    assert.equal(r.text, 'AI did: summarise: the meeting moved to Friday');
    assert.deepEqual(asked, [['@amy.veil', 'summarise: the meeting moved to Friday']]);
    const db = fs.readFileSync(path.join(dir, 'fabric.db'));
    assert.ok(!db.includes('meeting moved'), 'only ciphertext on the relay');
    assert.ok(!fs.readFileSync(stateFile, 'utf8').includes('meeting moved'), 'and no task text in Scalvs\'s own state');
  });

  await t.test('sealed sender: the relay does not learn who wrote to Scalvs; Scalvs still knows and replies', async () => {
    const r = await textScalvs(port, amy, 'ping', { sealedWith: amy.scalvsKey });
    assert.equal(r.text, 'pong');
  });

  await t.test('nobody else can register +scalvs.veil', async () => {
    const squatter = await newAccount(SCALVS_HANDLE);
    const { c, error } = await signIn(port, squatter);
    assert.equal(error, 'handle taken', 'Scalvs already holds it'); // and before it signs in: 'handle reserved' (below)
    c.close();
  });

  await t.test('Scalvs keeps its keys and sessions across a relay restart', async () => {
    const before = relay.scalvs.accountKey;
    amy.session.c.close();
    await relay.close();
    relay = await createRelay({ port: 0, dataFile: path.join(dir, 'fabric.db'), log: () => {}, scalvs: { stateFile, ai } });
    await relay.scalvsReady;
    assert.deepEqual(relay.scalvs.accountKey, before);
    amy.session = await signIn(relay.port, amy); // amy's ratchet store carries over too
    const r = await textScalvs(relay.port, amy, 'remind me in 1h to stretch');
    assert.equal(r.text, "OK, in 1h I'll remind you: stretch");
    const r2 = await textScalvs(relay.port, amy, 'reminders');
    assert.match(r2.text, /stretch/);
  });
});

test('Scalvs off: the handle stays reserved and the API says so', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {} });
  t.after(() => relay.close());
  assert.deepEqual(await (await fetch(`${relay.url}/api/scalvs`)).json(), { enabled: false, handle: null, ai: false });
  const { c, error } = await signIn(relay.port, await newAccount(SCALVS_HANDLE));
  assert.equal(error, 'handle reserved');
  c.close();
});
