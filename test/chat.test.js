import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaOf, b64Bytes, safeFileName, mediaLabel, fmtDuration, MAX_MEDIA_BYTES,
  receiptPayload, applyReceipt, unreadFrom, freshTyping,
  groupOf, newGroup, mergeGroup, groupKey, isGroupKey, groupIdOf, MAX_GROUP,
  orderChats,
} from '../shared/chat.js';

const A = '@alice.veil', B = '@bob.veil', C = '@carol.veil', D = '@dave.veil';
const b64 = (n) => Buffer.alloc(n, 7).toString('base64');

test('media: images, voice and files are checked; oversize and bad types refused', () => {
  const img = mediaOf({ media: { type: 'image', mime: 'image/jpeg', name: 'x.jpg', data: b64(1000), w: 640, h: 480 } });
  assert.equal(img.size, 1000);
  assert.equal(img.w, 640);
  const voice = mediaOf({ media: { type: 'audio', mime: 'audio/webm;codecs=opus', data: b64(500), dur: 12.34 } });
  assert.equal(voice.dur, 12.3);
  assert.equal(mediaOf({ media: { type: 'audio', mime: 'audio/webm', data: b64(9), dur: 9999 } }).dur, 120);
  const file = mediaOf({ media: { type: 'file', mime: 'not a mime', name: '../../evil‮.exe', data: b64(10) } });
  assert.equal(file.mime, 'application/octet-stream');
  assert.ok(!file.name.includes('/') && !file.name.includes('‮'));
  assert.equal(mediaOf({ media: { type: 'image', mime: 'image/svg+xml', data: b64(10) } }), null, 'svg can carry script');
  assert.equal(mediaOf({ media: { type: 'image', mime: 'image/png', data: b64(MAX_MEDIA_BYTES + 3) } }), null);
  assert.equal(mediaOf({ media: { type: 'video', mime: 'video/mp4', data: b64(10) } }), null);
  assert.equal(mediaOf({ media: { type: 'image', mime: 'image/png', data: 'not base64!' } }), null);
  assert.equal(mediaOf({ text: 'hi' }), null);
});

test('media helpers', () => {
  assert.equal(b64Bytes(b64(10)), 10);
  assert.equal(b64Bytes(b64(11)), 11);
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('...hidden'), 'hidden');
  assert.equal(fmtDuration(65), '1:05');
  assert.equal(mediaLabel({ type: 'image' }), '📷 Photo');
  assert.equal(mediaLabel({ type: 'audio', dur: 7 }), '🎤 Voice message (0:07)');
  assert.equal(mediaLabel({ type: 'file', name: 'a.pdf' }, 'see this'), '📎 a.pdf · see this');
});

test('read receipts mark only my messages, once', () => {
  const t = [
    { id: 'mineAAAAAAAA1', from: A, text: 'one' },
    { id: 'theirsAAAAAA2', from: B, text: 'two' },
    { id: 'mineAAAAAAAA3', from: A, text: 'three' },
  ];
  const p = receiptPayload(['mineAAAAAAAA1', 'theirsAAAAAA2', 'bad id', 'mineAAAAAAAA1']);
  assert.deepEqual(p.ids, ['mineAAAAAAAA1', 'theirsAAAAAA2']);
  assert.equal(applyReceipt(t, A, p, 5), 1);
  assert.equal(t[0].read, 5);
  assert.equal(t[1].read, undefined, "someone else's message");
  assert.equal(applyReceipt(t, A, p, 9), 0, 'already read');
  assert.equal(t[0].read, 5);
  assert.deepEqual(unreadFrom(t, A).map((m) => m.id), ['theirsAAAAAA2']);
});

test('typing signals expire, and late ones are ignored', () => {
  assert.ok(freshTyping(1000, 2000));
  assert.ok(!freshTyping(1000, 10_000));
  assert.ok(!freshTyping(NaN, 0));
});

test('groups: checked descriptions, keys and membership rules', () => {
  const id = 'grpAAAAAAAAAAAA';
  const g = newGroup(id, '  Team\u0007 ', A, [B, C, B]);
  assert.deepEqual(g, { id, name: 'Team', members: [A, B, C] });
  assert.equal(groupKey(id), '#' + id);
  assert.ok(isGroupKey('#' + id) && !isGroupKey(A) && groupIdOf('#' + id) === id);
  assert.equal(groupOf({ group: { id, name: 'x', members: [A] } }), null, 'needs two members');
  assert.equal(groupOf({ group: { id: '../x', name: 'x', members: [A, B] } }), null);
  assert.equal(groupOf({ group: { id, members: [A, 'nope'] } }), null);
  assert.equal(groupOf({ group: { id, members: Array.from({ length: MAX_GROUP + 1 }, (_, i) => `@u${i}x.veil`) } }), null);

  // learning about a group: only from a listed member, and only if I'm listed
  assert.equal(mergeGroup(null, g, D, B), null, 'stranger');
  assert.equal(mergeGroup(null, g, A, D), null, "I'm not in it");
  const mine = mergeGroup(null, g, A, B);
  assert.deepEqual(mine.members, [A, B, C]);

  // a plain message never changes my copy; members rename, add and leave
  assert.deepEqual(mergeGroup(mine, { ...g, name: 'Hijack', members: [A, D] }, A, B, 'msg'), mine);
  assert.equal(mergeGroup(mine, g, D, B, 'rename'), null, 'non-member');
  assert.equal(mergeGroup(mine, { ...g, name: 'New' }, C, B, 'rename').name, 'New');
  assert.deepEqual(mergeGroup(mine, { ...g, members: [D] }, C, B, 'add').members, [A, B, C, D]);
  assert.deepEqual(mergeGroup(mine, g, C, B, 'leave').members, [A, B]);
});

test('chat list: pinned first, then recent; archived kept apart', () => {
  const ts = { a: 1, b: 5, c: 3, d: 9 };
  const prefs = { a: { pinned: 100 }, c: { pinned: 200 }, d: { archived: true } };
  assert.deepEqual(orderChats(['a', 'b', 'c', 'd'], prefs, (k) => ts[k]), ['c', 'a', 'b']);
  assert.deepEqual(orderChats(['a', 'b', 'c', 'd'], prefs, (k) => ts[k], { archived: true }), ['d']);
});
