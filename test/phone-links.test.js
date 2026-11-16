// Linked phone numbers: verify by code, store only a keyed hash, opt-in and rate-limited discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../server/relay.js';
import { linksFromEnv, twilioVerifier, numberMac, devVerifier } from '../server/links.js';
import { normalizeHandle } from '../shared/crypto.js';
import { signIn } from './phone-helpers.js';

const PEPPER = 'p'.repeat(40);
const CFG = { mode: 'dev', pepper: PEPPER, countries: ['+1'] };

async function relayWith(t, extra = {}) {
  const verifier = devVerifier(() => {});
  const clock = { t: Date.now() };
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, links: CFG, linkVerifier: verifier, linkClock: () => clock.t, origins: ['http://localhost:8788'], ...extra });
  t.after(() => relay.close());
  return { relay, verifier, clock, port: relay.port };
}

test('links config: Twilio Verify with a long pepper, dev mode, or off', () => {
  assert.equal(linksFromEnv({}), null);
  const env = { TWILIO_VERIFY_SERVICE_SID: 'VA1', TWILIO_API_KEY_SID: 'SK1', TWILIO_API_KEY_SECRET: 's', FABRIC_NUMBER_PEPPER: PEPPER };
  assert.equal(linksFromEnv(env).mode, 'twilio');
  assert.equal(linksFromEnv({ ...env, FABRIC_NUMBER_PEPPER: 'short' }), null, 'a weak pepper is refused');
  assert.equal(linksFromEnv({ FABRIC_NUMBER_VERIFY: 'dev' }).mode, 'dev');
  assert.deepEqual(linksFromEnv({ ...env, FABRIC_LINK_COUNTRIES: '+1,+44,bad' }).countries, ['+1', '+44']);
});

test('dev verification is refused when the relay allows a non-local origin', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, links: CFG, origins: ['https://relay.example'] });
  t.after(() => relay.close());
  const ana = await signIn(relay.port, '@ana.veil');
  t.after(() => ana.ws.close());
  const st = await ana.ask({ type: 'number_status' }, 'number_status');
  assert.equal(st.enabled, false);
});

test('twilio verifier: texts through Verify and reads "approved"', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: String(init.body), auth: init.headers.authorization });
    const approved = url.endsWith('VerificationCheck') && init.body.includes('Code=123456');
    return { ok: true, status: 200, json: async () => ({ status: approved ? 'approved' : 'pending' }) };
  };
  const v = twilioVerifier({ serviceSid: 'VA1', user: 'SK1', pass: 's', fetchImpl });
  await v.start('+15551230000');
  assert.equal(await v.check('+15551230000', '000000'), false);
  assert.equal(await v.check('+15551230000', '123456'), true);
  assert.match(calls[0].url, /Services\/VA1\/Verifications$/);
  assert.match(calls[0].body, /To=%2B15551230000&Channel=sms/);
  assert.equal(calls[0].auth, 'Basic ' + Buffer.from('SK1:s').toString('base64'));
});

test('relay: verify, discover only when opted in, recycle, unlink', async (t) => {
  const { relay, verifier, clock, port } = await relayWith(t);
  const ana = await signIn(port, '@ana.veil');
  const ben = await signIn(port, '@ben.veil');
  const cat = await signIn(port, '@cat.veil');
  t.after(() => { ana.ws.close(); ben.ws.close(); cat.ws.close(); });
  const NUM = '+15551234567';

  assert.deepEqual((await ana.ask({ type: 'number_status' }, 'number_status')).linked, null);
  await assert.rejects(ana.ask({ type: 'number_verify_start', number: '+445551234567' }, 'number_code_sent'), /starting with \+1/);
  await assert.rejects(ana.ask({ type: 'number_verify_check', code: '123456' }, 'number_linked'), /expired/);

  await ana.ask({ type: 'number_verify_start', number: NUM }, 'number_code_sent');
  await assert.rejects(ana.ask({ type: 'number_verify_check', code: '000000' === verifier.peek(NUM) ? '111111' : '000000' }, 'number_linked'), /wrong code \(4 tries left\)/);
  const linked = await ana.ask({ type: 'number_verify_check', code: verifier.peek(NUM) }, 'number_linked');
  assert.equal(linked.linked.discoverable, false, 'not findable until the owner says so');

  // the relay keeps a keyed hash, never the number
  const row = relay.store.numberLinkOf('@ana.veil');
  assert.equal(row.mac, numberMac(PEPPER, NUM));
  assert.equal(JSON.stringify(row).includes('5551234567'), false);

  // not discoverable: reads the same as an unknown number
  let r = await ben.ask({ type: 'number_lookup', numbers: [NUM, '+15550000000', 'nonsense'] }, 'number_lookup');
  assert.deepEqual(r.results, { [NUM]: null, '+15550000000': null, nonsense: null });

  await ana.ask({ type: 'number_discoverable', on: true }, 'number_status');
  r = await ben.ask({ type: 'number_lookup', numbers: [NUM] }, 'number_lookup');
  assert.equal(r.results[NUM], '@ana.veil');

  // the number is recycled: cat verifies it, ana loses the link and is told
  clock.t += 3 * 60_000; // past the per-number rest
  await cat.ask({ type: 'number_verify_start', number: NUM }, 'number_code_sent');
  const told = ana.next((m) => m.type === 'number_status' && m.reason === 'claimed');
  await cat.ask({ type: 'number_verify_check', code: verifier.peek(NUM) }, 'number_linked');
  assert.equal((await told).linked, null);
  r = await ben.ask({ type: 'number_lookup', numbers: [NUM] }, 'number_lookup');
  assert.equal(r.results[NUM], null, 'cat has not opted in');

  await cat.ask({ type: 'number_unlink' }, 'number_status');
  assert.equal(relay.store.numberLinkOf('@cat.veil'), null);
  await assert.rejects(cat.ask({ type: 'number_discoverable', on: true }, 'number_status'), /link a number first/);
});

test('relay: limits on codes, wrong guesses and lookups', async (t) => {
  const { verifier, port } = await relayWith(t);
  const ana = await signIn(port, '@ana.veil');
  const ben = await signIn(port, '@ben.veil');
  t.after(() => { ana.ws.close(); ben.ws.close(); });

  // five wrong codes void the attempt
  await ana.ask({ type: 'number_verify_start', number: '+15551110000' }, 'number_code_sent');
  const wrong = verifier.peek('+15551110000') === '999999' ? '999998' : '999999';
  for (let i = 0; i < 4; i++) await assert.rejects(ana.ask({ type: 'number_verify_check', code: wrong }, 'number_linked'), /wrong code/);
  await assert.rejects(ana.ask({ type: 'number_verify_check', code: wrong }, 'number_linked'), /too many wrong codes/);
  await assert.rejects(ana.ask({ type: 'number_verify_check', code: verifier.peek('+15551110000') }, 'number_linked'), /expired/);

  // the same number can't be texted again right away, by anyone
  await assert.rejects(ben.ask({ type: 'number_verify_start', number: '+15551110000' }, 'number_code_sent'), /just sent/);
  await ana.ask({ type: 'number_verify_start', number: '+15551110001' }, 'number_code_sent');
  // three code requests an hour per account
  await ana.ask({ type: 'number_verify_start', number: '+15551110002' }, 'number_code_sent');
  await assert.rejects(ana.ask({ type: 'number_verify_start', number: '+15551110003' }, 'number_code_sent'), /too many codes/);

  // lookups: at most 50 per request, 200 a day
  const nums = (from) => Array.from({ length: 50 }, (_, i) => `+1555200${String(from + i).padStart(4, '0')}`);
  await assert.rejects(ben.ask({ type: 'number_lookup', numbers: nums(0).concat('+15559999999') }, 'number_lookup'), /1 to 50/);
  for (let k = 0; k < 4; k++) await ben.ask({ type: 'number_lookup', numbers: nums(k * 50) }, 'number_lookup');
  await assert.rejects(ben.ask({ type: 'number_lookup', numbers: nums(200) }, 'number_lookup'), /too many lookups/);
});

test('handles typed with + resolve like @', () => {
  assert.equal(normalizeHandle('+ana'), '@ana.veil');
});
