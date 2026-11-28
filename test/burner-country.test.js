// Burner numbers outside +1: a pool can hold numbers from several countries, a new burner can
// ask for one, and rotating keeps the country unless told otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../server/relay.js';
import { callingCode } from '../shared/calling-code.js';
import { dialable } from '../server/phone.js';
import { CFG, signIn } from './phone-helpers.js';

test('calling codes: one, two and three digits', () => {
  assert.equal(callingCode('+15550001001'), '+1');
  assert.equal(callingCode('+79161234567'), '+7');
  assert.equal(callingCode('+447700900123'), '+44');
  assert.equal(callingCode('+4915123456789'), '+49');
  assert.equal(callingCode('+35312345678'), '+353');
  assert.equal(callingCode('+972501234567'), '+972');
  assert.equal(callingCode('+8613812345678'), '+86');
  assert.equal(callingCode('+85212345678'), '+852');
  assert.equal(callingCode('447700900123'), null);
  assert.equal(callingCode('+44'), null);
});

test('relay: burners by country, and rotation keeps the country', async (t) => {
  const pool = ['+15550009001', '+447700900001', '+447700900002', '+4915100000001'];
  const phone = { ...CFG, countries: ['+1', '+44', '+49'], burner: { enabled: true, pool, cooldownMs: 60_000 } };
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, phone, fetchImpl: async () => new Response('{}'), operatorToken: 'op' });
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.port}`;
  const op = (path, body) => fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer op' }, body: JSON.stringify(body) });
  const ana = await signIn(relay.port, '@ana.veil');
  t.after(() => ana.ws.close());
  assert.equal((await op('/api/phone/bundles', { handle: '@ana.veil', size: 5, period: 'month' })).status, 200);

  const st = await ana.ask({ type: 'phone_status' }, 'phone_status');
  assert.deepEqual(st.burners.availableCodes, ['+1', '+44', '+49']);

  const uk = await ana.ask({ type: 'burner_create', country: '+44' }, 'burner_created');
  assert.equal(callingCode(uk.line), '+44');
  await assert.rejects(ana.ask({ type: 'burner_create', country: '+33' }, 'burner_created'), /no numbers are free right now from \+33/);
  await assert.rejects(ana.ask({ type: 'burner_create', country: 'uk' }, 'burner_created'), /bad country code/);

  // rotating a UK number gives the other UK number
  const rot = await ana.ask({ type: 'burner_rotate', number: uk.line }, 'burner_rotated');
  assert.equal(callingCode(rot.line), '+44');
  assert.notEqual(rot.line, uk.line);
  // no UK number left (the burned one rests): rotation refuses rather than switching country
  await assert.rejects(ana.ask({ type: 'burner_rotate', number: rot.line }, 'burner_rotated'), /no numbers are free right now from \+44/);
  // unless the device asks for another country
  const de = await ana.ask({ type: 'burner_rotate', number: rot.line, country: '+49' }, 'burner_rotated');
  assert.equal(callingCode(de.line), '+49');

  // without a country, any free number, as before
  const any = await ana.ask({ type: 'burner_create' }, 'burner_created');
  assert.equal(any.line, '+15550009001');
  assert.deepEqual(any.burners.availableCodes, []);
});

test('premium-rate lines are not dialable, at home or abroad', () => {
  const all = ['+1', '+44', '+49', '+33', '+61', '+7'];
  for (const n of ['+19005551234', '+449012345678', '+4990012345', '+33899123456', '+61190012345', '+78091234567']) assert.equal(dialable(n, all), false, n);
  for (const n of ['+15551234567', '+447700900123', '+33612345678', '+79161234567']) assert.equal(dialable(n, all), true, n);
  assert.equal(dialable('+447700900123', ['+1']), false, 'only the allowed countries');
});
