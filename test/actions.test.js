import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction, actionPayload, quoteOf, replyOf, extrasOf, isReaction, reactionSummary, MAX_QUOTE,
} from '../shared/actions.js';

const A = '@alice.veil';
const B = '@bob.veil';
const thread = () => [
  { id: 'msgAAAAAAAAAAAA1', from: A, text: 'hello', ts: 1 },
  { id: 'msgBBBBBBBBBBBB2', from: B, text: 'hi there', ts: 2, tr: { text: 'hola', from: 'en' } },
  { id: 'sys-1', from: '@system', text: 'Missed voice call', ts: 3 },
];

test('edit: only the author can edit; the text changes, a stale translation goes', () => {
  const t = thread();
  assert.equal(applyAction(t, A, actionPayload('edit', 'msgBBBBBBBBBBBB2', { text: 'hijacked' })), null);
  const m = applyAction(t, B, actionPayload('edit', 'msgBBBBBBBBBBBB2', { text: 'hi there!' }), 50);
  assert.equal(m.text, 'hi there!');
  assert.equal(m.edited, 50);
  assert.equal(m.tr, undefined);
  assert.equal(applyAction(t, B, actionPayload('edit', 'msgBBBBBBBBBBBB2', { text: '   ' })), null, 'empty edit refused');
});

test('delete for everyone: author only, leaves a tombstone, then refuses edits and reactions', () => {
  const t = thread();
  assert.equal(applyAction(t, B, actionPayload('delete', 'msgAAAAAAAAAAAA1')), null);
  applyAction(t, B, actionPayload('react', 'msgAAAAAAAAAAAA1', { emoji: '👍' }));
  const m = applyAction(t, A, actionPayload('delete', 'msgAAAAAAAAAAAA1'), 9);
  assert.equal(m.deleted, 9);
  assert.equal(m.text, '');
  assert.equal(m.reactions, undefined);
  assert.equal(t.length, 3, 'still in the thread');
  assert.equal(applyAction(t, A, actionPayload('edit', 'msgAAAAAAAAAAAA1', { text: 'back' })), null);
  assert.equal(applyAction(t, B, actionPayload('react', 'msgAAAAAAAAAAAA1', { emoji: '😂' })), null);
});

test('reactions: one per person, replaced or removed, summarized with mine marked', () => {
  const t = thread();
  applyAction(t, A, actionPayload('react', 'msgBBBBBBBBBBBB2', { emoji: '👍' }));
  applyAction(t, B, actionPayload('react', 'msgBBBBBBBBBBBB2', { emoji: '👍' }));
  applyAction(t, A, actionPayload('react', 'msgBBBBBBBBBBBB2', { emoji: '❤️' }));
  assert.deepEqual(t[1].reactions, { [A]: '❤️', [B]: '👍' });
  assert.deepEqual(reactionSummary(t[1], A).map((g) => [g.emoji, g.count, g.mine]).sort(), [['❤️', 1, true], ['👍', 1, false]]);
  applyAction(t, A, actionPayload('react', 'msgBBBBBBBBBBBB2', { emoji: '' }));
  applyAction(t, B, actionPayload('react', 'msgBBBBBBBBBBBB2', { emoji: '' }));
  assert.equal(t[1].reactions, undefined);
  assert.equal(applyAction(t, A, { kind: 'action', act: 'react', target: 'msgBBBBBBBBBBBB2', emoji: '<script>' }), null);
  assert.equal(applyAction(t, A, { kind: 'action', act: 'react', target: 'msgBBBBBBBBBBBB2', emoji: 'lol' }), null);
});

test('unknown targets, system lines and unknown acts are ignored', () => {
  const t = thread();
  assert.equal(applyAction(t, A, actionPayload('react', 'msgZZZZZZZZZZZZ9', { emoji: '👍' })), null);
  assert.equal(applyAction(t, '@system', { kind: 'action', act: 'delete', target: 'sys-1' }), null);
  assert.equal(applyAction(t, A, { kind: 'action', act: 'burn', target: 'msgAAAAAAAAAAAA1' }), null);
  assert.throws(() => actionPayload('burn', 'msgAAAAAAAAAAAA1'));
  assert.throws(() => actionPayload('edit', 'x'));
});

test('replies and forwards: quotes are trimmed, malformed ones dropped', () => {
  const long = { id: 'msgCCCCCCCCCCCC3', from: A, text: 'x'.repeat(1000) };
  const q = quoteOf(long);
  assert.equal(q.text.length, MAX_QUOTE);
  assert.deepEqual(replyOf({ reply: q }), q);
  assert.equal(replyOf({ reply: { id: '../../etc', from: A, text: 'x' } }), null);
  assert.equal(replyOf({ reply: 'nope' }), null);
  assert.deepEqual(extrasOf({ text: 'hi', reply: q, fwd: true }), { reply: q, forwarded: true });
  assert.deepEqual(extrasOf({ text: 'hi', fwd: 'yes' }), {});
  assert.equal(quoteOf({ id: 'msgDDDDDDDDDDDD4', from: B, text: 'secret', deleted: 5 }).text, '');
});

test('isReaction accepts emoji, refuses words and markup', () => {
  for (const e of ['👍', '❤️', '🙏🏽', '👨‍👩‍👧']) assert.ok(isReaction(e), e);
  for (const e of ['', 'ok', '1', '<b>', ' ', '👍👍👍👍👍👍👍👍👍']) assert.ok(!isReaction(e), JSON.stringify(e));
});
