import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, contributionWeight } from '../shared/economy.js';
import { summarize } from '../shared/summarize.js';

test('worked example from the product page: $100k across 10,000 equal users = $7.00 each', () => {
  const weights = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`@u${i}.veil`, 1]));
  const r = allocate(100000, weights);
  assert.equal(r.poolCents, 7_000_000);
  assert.equal(r.infinitumCents, 3_000_000);
  assert.equal(r.participants, 10000);
  assert.ok(Object.values(r.allocations).every((c) => c === 700));
});

test('allocations are weighted and always sum exactly to the pool', () => {
  const r = allocate(1000.01, { '@a.veil': 1, '@b.veil': 2, '@c.veil': 3, '@d.veil': 0 });
  const sum = Object.values(r.allocations).reduce((s, c) => s + c, 0);
  assert.equal(sum, r.poolCents);
  assert.equal(r.poolCents + r.infinitumCents, r.revenueCents);
  assert.equal(r.participants, 3);
  assert.ok(!('@d.veil' in r.allocations));
  assert.ok(r.allocations['@c.veil'] > r.allocations['@b.veil']);
});

test('no consent, no weight', () => {
  const counters = { usage: 50, network: 50, research: 10 };
  assert.equal(contributionWeight({ usage: false, network: false, research: false }, counters), 0);
  assert.equal(contributionWeight({ usage: true }, counters), 50);
  assert.equal(contributionWeight({ usage: true, network: true, research: true }, counters), 50 + 25 + 2.5);
});

test('summary picks out an open question', () => {
  const s = summarize([
    { from: '@bob.veil', text: 'The shipment for the Denver site slipped' },
    { from: '@me.veil', text: 'How late is the Denver shipment?' },
    { from: '@bob.veil', text: 'Two days. Can you approve the Denver overtime?' },
  ], { me: '@me.veil' });
  assert.ok(s.some((l) => l.startsWith('Open question for you')));
  assert.ok(s.some((l) => l.includes('denver')));
});
