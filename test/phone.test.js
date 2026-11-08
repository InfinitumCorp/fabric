import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import {
  accessToken, twilioSignature, validSignature, dialable, identityOf, handleOfIdentity, phoneFromEnv,
} from '../server/phone.js';
import { createRelay } from '../server/relay.js';
import { toE164, formatNumber } from '../public/phone.js';
import { generateUserIdentity, generateSigningKey, ownershipProof } from '../shared/crypto.js';
import { signDeviceList, newDeviceId } from '../shared/devices.js';

const CFG = {
  accountSid: 'AC' + 'a'.repeat(32), authToken: 'auth-token-test', apiKey: 'SK' + 'b'.repeat(32),
  apiSecret: 'api-secret-test', appSid: 'AP' + 'c'.repeat(32), publicUrl: 'https://fabric.example.test',
  countries: ['+1'], numbers: {},
};

test('phone config needs every Twilio setting', () => {
  assert.equal(phoneFromEnv({}), null);
  const env = {
    TWILIO_ACCOUNT_SID: CFG.accountSid, TWILIO_AUTH_TOKEN: 'x', TWILIO_API_KEY_SID: CFG.apiKey,
    TWILIO_API_KEY_SECRET: 'y', TWILIO_TWIML_APP_SID: CFG.appSid, FABRIC_PUBLIC_URL: 'https://a.test/',
  };
  const cfg = phoneFromEnv(env);
  assert.equal(cfg.publicUrl, 'https://a.test');
  assert.deepEqual(cfg.countries, ['+1']);
  assert.equal(phoneFromEnv({ ...env, TWILIO_AUTH_TOKEN: '' }), null);
});

test('access tokens are Twilio JWTs with a voice grant, signed with the API secret', () => {
  const now = Date.UTC(2026, 10, 6);
  const t = accessToken(CFG, 'ana', { now, ttl: 600 });
  const [h, p, s] = t.split('.');
  assert.equal(s, createHmac('sha256', CFG.apiSecret).update(`${h}.${p}`).digest('base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.iss, CFG.apiKey);
  assert.equal(payload.sub, CFG.accountSid);
  assert.equal(payload.exp - payload.iat, 600);
  assert.deepEqual(payload.grants, { identity: 'ana', voice: { incoming: { allow: true }, outgoing: { application_sid: CFG.appSid } } });
});

test('webhook signatures follow Twilio’s scheme; numbers are checked before dialing', () => {
  // the example from Twilio's webhook security docs
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  assert.equal(twilioSignature('12345', url, params), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  assert.equal(validSignature('12345', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), true);
  assert.equal(validSignature('12345', url, { ...params, To: '+19005551212' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), false);
  assert.equal(validSignature('12345', url, params, undefined), false);

  assert.equal(dialable('+15551234567', ['+1']), true);
  assert.equal(dialable('+19005551234', ['+1']), false, 'premium rate');
  assert.equal(dialable('+447700900123', ['+1']), false, 'country not allowed');
  assert.equal(dialable('+447700900123', ['+1', '+44']), true);
  assert.equal(dialable('5551234567', ['+1']), false);
  assert.equal(identityOf('@ana.veil'), 'ana');
  assert.equal(handleOfIdentity('client:ana'), '@ana.veil');
  assert.equal(handleOfIdentity('client:<x>'), null);

  assert.equal(toE164('(555) 123-4567'), '+15551234567');
  assert.equal(toE164('1 555 123 4567'), '+15551234567');
  assert.equal(toE164('+44 7700 900123'), '+447700900123');
  assert.equal(toE164('0044 7700 900123'), '+447700900123');
  assert.equal(toE164('123'), null);
  assert.equal(formatNumber('+15551234567'), '+1 (555) 123-4567');
});

// ---------- against a running relay ----------
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
  return { ws, next, send, ask };
}

async function signIn(port, handle) {
  const acct = await generateSigningKey();
  const dev = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(acct.privateJwk, {
    handle, version: 1, account: acct.publicJwk,
    devices: [{ id: dev.id, name: 'test', dh: dev.keys.dh.publicJwk, sig: dev.keys.sig.publicJwk, addedAt: 1 }],
  });
  const c = client(port);
  const hello = await c.next((m) => m.type === 'hello');
  const proof = await ownershipProof(dev.keys.dh.privateJwk, hello.relayKey, hello.nonce);
  c.send({ type: 'register', handle, deviceId: dev.id, list, proof });
  const res = await c.next((m) => m.type === 'registered' || m.type === 'error');
  assert.equal(res.type, 'registered', res.error);
  return c;
}

async function webhook(port, path, params, { sign = true } = {}) {
  const sig = twilioSignature(CFG.authToken, CFG.publicUrl + path, params);
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sign ? { 'x-twilio-signature': sig } : {}) },
    body: new URLSearchParams(params),
  });
  return { status: r.status, body: await r.text() };
}

test('relay: a number per account; calls, voicemail and texts reach its devices', async (t) => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    if (url.endsWith('/Messages.json')) return new Response(JSON.stringify({ sid: 'SM' + '1'.repeat(32) }), { status: 201 });
    if (url.endsWith('.mp3')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, phone: CFG, fetchImpl, operatorToken: 'op' });
  t.after(() => relay.close());
  const { port } = relay;
  const base = `http://127.0.0.1:${port}`;
  const ana = await signIn(port, '@ana.veil');
  t.after(() => ana.ws.close());

  const st0 = await ana.ask({ type: 'phone_status' }, 'phone_status');
  assert.deepEqual({ enabled: st0.enabled, number: st0.number, countries: st0.countries }, { enabled: true, number: null, countries: ['+1'] });
  assert.equal('burners' in st0, false, 'burner numbers are off unless FABRIC_BURNERS=1');
  await assert.rejects(ana.ask({ type: 'burner_create' }, 'burner_created'), /not available/);
  await assert.rejects(ana.ask({ type: 'phone_token' }, 'phone_token'), /no phone number/);

  // the operator assigns a number; only known accounts can get one
  const assign = (body, auth = 'Bearer op') => fetch(`${base}/api/phone/numbers`, { method: 'POST', headers: { authorization: auth }, body: JSON.stringify(body) });
  assert.equal((await assign({ number: '+15550001111', handle: '@nobody.veil' })).status, 400);
  assert.equal((await assign({ number: '+15550001111', handle: '@ana.veil' }, 'Bearer nope')).status, 403);
  assert.equal((await assign({ number: 'not a number', handle: '@ana.veil' })).status, 400);
  const ok = await assign({ number: '+15550001111', handle: '@ana.veil' });
  assert.deepEqual((await ok.json()).numbers, [{ number: '+15550001111', handle: '@ana.veil' }]);
  assert.equal((await ana.next((m) => m.type === 'phone_status')).number, '+15550001111', 'pushed to the account');
  const tok = await ana.ask({ type: 'phone_token' }, 'phone_token');
  assert.equal(tok.identity, 'ana');
  assert.equal(tok.token.split('.').length, 3);

  // the CSP lets the SDK reach Twilio; the SDK itself comes from this origin
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/\*\.twilio\.com wss:\/\/\*\.twilio\.com/);
  assert.equal((await fetch(base + '/vendor/twilio.min.js')).status, 200);

  // webhooks without Twilio's signature are refused
  assert.equal((await webhook(port, '/api/phone/sms', { To: '+15550001111', From: '+15557654321', Body: 'hi' }, { sign: false })).status, 403);

  // an incoming call rings ana's browser, then goes to voicemail
  const callSid = 'CA' + '9'.repeat(32);
  const inc = await webhook(port, '/api/phone/incoming', { To: '+15550001111', From: '+15557654321', CallSid: callSid });
  assert.equal(inc.status, 200);
  assert.match(inc.body, /<Dial timeout="25" action="https:\/\/fabric\.example\.test\/api\/phone\/missed\?n=%2B15550001111"><Client><Identity>ana<\/Identity>/);
  assert.match(inc.body, /<Parameter name="from" value="\+15557654321"\/>/);
  assert.equal((await ana.next((m) => m.type === 'phone_event')).event.kind, 'call');
  assert.match((await webhook(port, '/api/phone/incoming', { To: '+15559999999', From: '+15557654321' })).body, /not in service/);
  assert.match((await webhook(port, '/api/phone/missed?n=%2B15550001111', { DialCallStatus: 'completed' })).body, /<Hangup\/>/);
  const missed = await webhook(port, '/api/phone/missed?n=%2B15550001111', { DialCallStatus: 'no-answer', From: '+15557654321', CallSid: callSid });
  assert.match(missed.body, /<Record maxLength="120"/);
  await webhook(port, '/api/phone/recording?n=%2B15550001111', {
    RecordingStatus: 'completed', RecordingSid: 'RE' + 'f'.repeat(32), RecordingDuration: '14', CallSid: callSid,
  });
  await webhook(port, '/api/phone/sms', { To: '+15550001111', From: '+15557654321', Body: 'hello <b>' });

  const { events } = await ana.ask({ type: 'phone_log' }, 'phone_log');
  assert.deepEqual(events.map((e) => e.kind), ['call', 'missed', 'voicemail', 'sms']);
  const vm = events[2];
  assert.equal(vm.peer, '+15557654321', 'the voicemail knows who called');
  assert.equal(vm.seconds, 14);
  assert.equal(events[3].text, 'hello <b>');
  const audio = await ana.ask({ type: 'phone_voicemail', seq: vm.seq }, 'phone_voicemail');
  assert.equal(audio.audio, Buffer.from([1, 2, 3]).toString('base64'));
  assert.match(sent.at(-1).url, /\/Recordings\/REf{32}\.mp3$/);
  assert.match(sent.at(-1).init.headers.authorization, /^Basic /);

  // ana texts back: From is her number; bad destinations never reach the carrier
  const before = sent.length;
  await assert.rejects(ana.ask({ type: 'sms_send', to: '+19005550000', text: 'x' }, 'sms_sent'), /cannot be texted/);
  await assert.rejects(ana.ask({ type: 'sms_send', to: '+15557654321', text: '' }, 'sms_sent'), /characters/);
  assert.equal(sent.length, before);
  const r = await ana.ask({ type: 'sms_send', to: '+15557654321', text: 'got it' }, 'sms_sent');
  assert.equal(r.event.dir, 'out');
  const body = new URLSearchParams(sent.at(-1).init.body);
  assert.deepEqual(Object.fromEntries(body), { From: '+15550001111', To: '+15557654321', Body: 'got it' });

  // outgoing call: caller ID is the account's own number, only allowed destinations
  const out = await webhook(port, '/api/phone/voice', { From: 'client:ana', To: '+15557654321', CallSid: 'CA' + '8'.repeat(32) });
  assert.match(out.body, /<Dial callerId="\+15550001111" answerOnBridge="true" timeLimit="14400"><Number>\+15557654321<\/Number><\/Dial>/);
  assert.match((await webhook(port, '/api/phone/voice', { From: 'client:ana', To: '+19005551234' })).body, /cannot be called/);
  assert.match((await webhook(port, '/api/phone/voice', { From: 'client:ben', To: '+15557654321' })).body, /no phone number/);
});

test('relay without phone config says so and serves no SDK', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, phone: null });
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.port}`;
  assert.equal((await fetch(base + '/vendor/twilio.min.js')).status, 404);
  assert.doesNotMatch((await fetch(base + '/')).headers.get('content-security-policy'), /twilio/);
  assert.equal((await fetch(base + '/api/phone/sms', { method: 'POST' })).status, 404);
  const c = await signIn(relay.port, '@ana.veil');
  t.after(() => c.ws.close());
  assert.equal((await c.ask({ type: 'phone_status' }, 'phone_status')).enabled, false);
  await assert.rejects(c.ask({ type: 'phone_token' }, 'phone_token'), /not configured/);
});
