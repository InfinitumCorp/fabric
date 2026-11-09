import test from 'node:test';
import assert from 'node:assert/strict';
import {
  locOf, mapsUrl, locFallback, cardOf, cardFallback, onceOf, spendOnce, mentionsIn, mentionsMe,
  mentionQuery, insertMention, dropFromBlocked, messageInfo, waExtrasOf,
} from '../shared/wa.js';

test('locations are checked, rounded and linked without fetching anything', () => {
  assert.deepEqual(locOf({ loc: { lat: 52.5200081234, lon: 13.40495, acc: 12.4, label: '  Office\n' } }), { lat: 52.520008, lon: 13.40495, acc: 12, label: 'Office' });
  for (const loc of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 'x', lon: 1 }, null, 'here'])
    assert.equal(locOf({ loc }), null);
  const l = { lat: 1.5, lon: -2.25 };
  assert.match(mapsUrl(l), /^https:\/\/www\.openstreetmap\.org\/\?mlat=1\.5&mlon=-2\.25/);
  assert.match(locFallback(l), /1\.5, -2\.25/);
});

test('contact cards carry a real handle', () => {
  assert.deepEqual(cardOf({ card: { handle: '@ann.veil', name: 'Ann' } }), { handle: '@ann.veil', name: 'Ann' });
  assert.equal(cardOf({ card: { handle: 'ann' } }), null);
  assert.equal(cardOf({ card: { handle: '@x.veil' } }), null); // too short
  assert.equal(cardFallback({ handle: '@ann.veil' }), '👤 @ann.veil');
});

test('view once is for photos and leaves only the label once opened', () => {
  assert.equal(onceOf({ once: true }, { type: 'image' }), true);
  assert.equal(onceOf({ once: true }, { type: 'file' }), false);
  const m = { once: true, media: { type: 'image', data: 'abc' } };
  assert.equal(spendOnce(m, 5), true);
  assert.equal(m.media.data, undefined);
  assert.equal(m.opened, 5);
  assert.equal(spendOnce({ media: { data: 'x' } }), false);
});

test('mentions only count members, and the picker follows the caret', () => {
  assert.deepEqual(mentionsIn('hi @ann.veil and @bob.veil, @ann.veil again @eve.veil', ['@ann.veil', '@bob.veil']), ['@ann.veil', '@bob.veil']);
  assert.equal(mentionsMe('ping @me_1.veil', '@me_1.veil'), true);
  assert.equal(mentionsMe('mail@me_1.veilx', '@me_1.veil'), false);
  assert.equal(mentionQuery('hello @an'), 'an');
  assert.equal(mentionQuery('hello @'), '');
  assert.equal(mentionQuery('mail@an'), null);
  assert.deepEqual(insertMention('hi @an there', 6, '@ann.veil'), { text: 'hi @ann.veil  there', caret: 13 });
});

test('blocked people are dropped in direct chats, not in groups', () => {
  const db = { blocked: { '@eve.veil': 1 } };
  assert.equal(dropFromBlocked(db, '@eve.veil', { kind: 'text' }), true);
  assert.equal(dropFromBlocked(db, '@eve.veil', { kind: 'text', group: { id: 'g' } }), false);
  assert.equal(dropFromBlocked(db, '@eve.veil', { kind: 'typing', gid: 'g' }), false);
  assert.equal(dropFromBlocked(db, '@ann.veil', { kind: 'text' }), false);
});

test('message info lists who read my message', () => {
  const m = { from: '@me.veil', readBy: { '@ann.veil': 7 } };
  assert.deepEqual(messageInfo(m, ['@me.veil', '@ann.veil', '@bob.veil'], '@me.veil'), [{ who: '@ann.veil', read: 7 }, { who: '@bob.veil' }]);
  assert.deepEqual(messageInfo({ from: '@me.veil', read: 3 }, [], '@me.veil'), [{ who: null, read: 3 }]);
  assert.deepEqual(messageInfo({ from: '@ann.veil' }, [], '@me.veil'), []);
});

test('extras keep only valid fields', () => {
  assert.deepEqual(waExtrasOf({ loc: { lat: 1, lon: 2 }, card: { handle: 'bad' }, once: true, media: { type: 'image' } }), { loc: { lat: 1, lon: 2 }, once: true });
  assert.deepEqual(waExtrasOf({ once: true, media: { type: 'file' } }), {});
});
