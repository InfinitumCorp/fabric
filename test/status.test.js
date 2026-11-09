import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusOf, expireStatuses, applyStatus, statusRows, statusAudience, cleanBroadcast, lockHash, lockCheck, STATUS_TTL, STATUS_BGS,
} from '../shared/status.js';

const SID = 'abcdefgh12';

test('status payloads are checked', () => {
  assert.deepEqual(statusOf({ kind: 'status', sid: SID, text: ' hi ', bg: STATUS_BGS[1] }), { sid: SID, text: 'hi', bg: STATUS_BGS[1] });
  assert.deepEqual(statusOf({ kind: 'status', sid: SID, del: true }), { sid: SID, del: true });
  assert.equal(statusOf({ kind: 'status', sid: SID }), null); // nothing in it
  assert.equal(statusOf({ kind: 'status', sid: 'x', text: 'a' }), null);
  assert.equal(statusOf({ kind: 'status', sid: SID, text: 'a', bg: 'red' }).bg, undefined);
  const bad = statusOf({ kind: 'status', sid: SID, media: { type: 'image', mime: 'image/svg+xml', data: 'PHN2Zz4=' } });
  assert.equal(bad, null); // svg isn't allowed, and then there's nothing left
  assert.ok(statusOf({ kind: 'status', sid: SID, media: { type: 'image', mime: 'image/jpeg', data: '/9j/4AAQ' } }).media);
});

test('statuses arrive once, can be deleted, and expire after a day', () => {
  const store = {};
  const now = 1e12;
  assert.equal(applyStatus(store, '@ann.veil', { sid: SID, text: 'a' }, now - 10, now), true);
  assert.equal(applyStatus(store, '@ann.veil', { sid: SID, text: 'a' }, now - 10, now), false);
  assert.equal(applyStatus(store, '@ann.veil', { sid: 'zzzzzzzz1', text: 'old' }, now - STATUS_TTL, now), false);
  assert.equal(statusRows(store)[0].unseen, true);
  store.from['@ann.veil'][0].seen = true;
  assert.equal(statusRows(store)[0].unseen, false);
  assert.equal(applyStatus(store, '@ann.veil', { sid: SID, del: true }, now, now), true);
  assert.equal(store.from['@ann.veil'], undefined);
  const s2 = { mine: [{ sid: SID, ts: now - STATUS_TTL - 1 }], from: { '@b_b.veil': [{ sid: SID, ts: now - 5 }] } };
  assert.equal(expireStatuses(s2, now), 1);
  assert.equal(s2.mine.length, 0);
  assert.equal(s2.from['@b_b.veil'].length, 1);
});

test('the audience skips groups, blocked people, bots and exclusions', () => {
  const out = statusAudience(['@ann.veil', '@eve.veil', 'g:1', '~saved', '@helpbot.veil', '@bob.veil'],
    { blocked: { '@eve.veil': 1 }, exclude: ['@bob.veil'], isBot: (h) => h.endsWith('bot.veil') });
  assert.deepEqual(out, ['@ann.veil']);
});

test('broadcast lists are cleaned', () => {
  assert.deepEqual(cleanBroadcast({ id: 'babc1234', name: '  Team  ', members: ['@ann.veil', '@ann.veil', 'bad'] }), { id: 'babc1234', name: 'Team', members: ['@ann.veil'] });
  assert.equal(cleanBroadcast({ id: 'babc1234', members: [] }), null);
  assert.equal(cleanBroadcast({ id: 'x', members: ['@ann.veil'] }), null);
});

test('the chat-lock code is checked against a salted hash', async () => {
  const lock = await lockHash('2468', undefined, 1000);
  assert.equal(lock.hash.length, 64);
  assert.notEqual(lock.hash, '2468');
  assert.equal(await lockCheck('2468', lock), true);
  assert.equal(await lockCheck('2469', lock), false);
  assert.equal(await lockCheck('2468', null), false);
});
