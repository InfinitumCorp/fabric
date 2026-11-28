import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSigningKey, safetyNumber, normalizeHandle, isValidHandle } from '../shared/crypto.js';

test('safety numbers match on both sides and change when either account key changes', async () => {
  const a = (await generateSigningKey()).publicJwk;
  const b = (await generateSigningKey()).publicJwk;
  const s1 = await safetyNumber('@alice.veil', a, '@bob.veil', b);
  assert.equal(s1, await safetyNumber('@bob.veil', b, '@alice.veil', a));
  assert.match(s1, /^(\d{5} ){11}\d{5}$/);
  const b2 = (await generateSigningKey()).publicJwk;
  assert.notEqual(s1, await safetyNumber('@alice.veil', a, '@bob.veil', b2));
  assert.notEqual(s1, await safetyNumber('@alice.veil', a, '@bobby.veil', b), 'bound to the handle too');
});

test('handles normalize to @name.veil', () => {
  assert.equal(normalizeHandle('Alex'), '@alex.veil');
  assert.equal(normalizeHandle('@alex.veil'), '@alex.veil');
  assert.equal(normalizeHandle('+Alex.veil'), '@alex.veil', 'the + people see and type maps to the same account');
  assert.ok(isValidHandle('@alex_01.veil'));
  assert.ok(!isValidHandle('@a.veil'));
  assert.ok(!isValidHandle('@al ex.veil'));
});
