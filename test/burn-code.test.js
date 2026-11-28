// Emergency burn code: set only with the account key, used once from /burn.html to burn every
// burner number of the account; and "burn all" from a signed-in device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../server/relay.js';
import { generateSigningKey } from '../shared/crypto.js';
import { newBurnCode, burnCodeHash, signBurnCode, checkBurnCode, BURN_CODE_HASH_RE } from '../shared/burn-code.js';
import { CFG, signIn } from './phone-helpers.js';

test('burn code: hash, signature, clock and replay checks', async () => {
  const code = newBurnCode();
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  const hash = await burnCodeHash(code);
  assert.match(hash, BURN_CODE_HASH_RE);
  assert.equal(await burnCodeHash(code.toLowerCase().replace(/-/g, ' ')), hash, 'typed loosely, same code');
  assert.notEqual(await burnCodeHash(newBurnCode()), hash);
  await assert.rejects(burnCodeHash('short'), /32 letters/);

  const acct = await generateSigningKey();
  const other = await generateSigningKey();
  const now = 1_800_000_000_000;
  const m = await signBurnCode(acct.privateJwk, { handle: '@ana.veil', hash, at: now });
  const ok = (msg, o = {}) => checkBurnCode(acct.publicJwk, msg, { handle: '@ana.veil', now, ...o });
  assert.equal(await ok(m), null);
  assert.equal(await ok(m, { handle: '@ben.veil' }), 'not signed by the account key', 'bound to the handle');
  assert.equal(await checkBurnCode(other.publicJwk, m, { handle: '@ana.veil', now }), 'not signed by the account key');
  assert.equal(await ok({ ...m, hash: hash.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }), 'not signed by the account key');
  assert.equal(await ok(m, { lastAt: now }), 'replayed');
  assert.match(await ok(m, { now: now + 11 * 60_000 }), /clock/);
  assert.equal(await ok({ ...m, hash: 'nope' }), 'bad code');
  const clear = await signBurnCode(acct.privateJwk, { handle: '@ana.veil', hash: '', at: now + 1 });
  assert.equal(await ok(clear, { lastAt: now }), null, 'turning it off is signed too');
});

test('relay: burn all from a device, and the emergency code from /burn.html', async (t) => {
  const phone = { ...CFG, burner: { enabled: true, pool: ['+15550009001', '+15550009002', '+15550009003'], cooldownMs: 60_000 } };
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, phone, fetchImpl: async () => new Response('{}'), operatorToken: 'op' });
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.port}`;
  const op = (path, body) => fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer op' }, body: JSON.stringify(body) });
  const burn = (body) => fetch(base + '/api/phone/burn-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ana = await signIn(relay.port, '@ana.veil');
  const ben = await signIn(relay.port, '@ben.veil');
  t.after(() => { ana.ws.close(); ben.ws.close(); });

  assert.equal((await op('/api/phone/bundles', { handle: '@ana.veil', size: 2, period: 'month' })).status, 200);
  assert.equal((await op('/api/phone/bundles', { handle: '@ben.veil', size: 1, period: 'month' })).status, 200);
  await ana.ask({ type: 'burner_create' }, 'burner_created');
  await ana.ask({ type: 'burner_create' }, 'burner_created');
  await ben.ask({ type: 'burner_create' }, 'burner_created');

  // a code is accepted only when the account key signed it
  const code = newBurnCode();
  const hash = await burnCodeHash(code);
  const forged = await signBurnCode((await generateSigningKey()).privateJwk, { handle: '@ana.veil', hash });
  await assert.rejects(ana.ask({ type: 'burner_code_set', ...forged }, 'burner_code_saved'), /not signed by the account key/);
  const signed = await signBurnCode(ana.account.privateJwk, { handle: '@ana.veil', hash });
  const saved = await ana.ask({ type: 'burner_code_set', ...signed }, 'burner_code_saved');
  assert.equal(saved.burners.burnCode, true);
  await assert.rejects(ana.ask({ type: 'burner_code_set', ...signed, ref: undefined }, 'burner_code_saved'), /replayed/);

  // wrong handle or wrong code: the same answer, nothing burned
  const wrongCode = await burn({ handle: '+ana.veil', code: newBurnCode() });
  assert.equal(wrongCode.status, 403);
  const wrongHandle = await burn({ handle: '+ben', code });
  assert.equal(wrongHandle.status, 403);
  assert.deepEqual(await wrongCode.json(), await wrongHandle.json());
  assert.equal((await burn({ handle: 'ana', code: 'x' })).status, 400);

  // the right one burns all of ana's burners, and only hers
  const ok = await burn({ handle: '+ana', code: code.toLowerCase() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { burned: 2 });
  const pushed = await ana.next((m) => m.type === 'phone_status' && !m.ref && m.burners.lines.length === 0);
  assert.equal(pushed.burners.burnCode, false, 'used once');
  assert.equal((await ben.ask({ type: 'phone_status' }, 'phone_status')).burners.lines.length, 1);
  assert.equal((await burn({ handle: '+ana', code })).status, 403, 'the code works once');

  // burn all from a signed-in device
  const all = await ben.ask({ type: 'burner_burn_all' }, 'burner_burned_all');
  assert.equal(all.burned, 1);
  assert.equal(all.burners.lines.length, 0);
  assert.equal((await ben.ask({ type: 'burner_burn_all' }, 'burner_burned_all')).burned, 0);

  // online guessing runs into the per-address limit
  let limited = false;
  for (let i = 0; i < 8 && !limited; i++) limited = (await burn({ handle: '+ben', code: newBurnCode() })).status === 429;
  assert.ok(limited, 'rate limited');
});
