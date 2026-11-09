import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarOf, isNewer, needsProfile, profilePayload, MAX_AVATAR_CHARS } from '../shared/profile.js';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

test('avatarOf accepts small image data URLs and removals', () => {
  assert.deepEqual(avatarOf({ v: 5, avatar: JPEG }), { data: JPEG, v: 5 });
  assert.deepEqual(avatarOf({ v: 6, avatar: null }), { data: null, v: 6 });
  assert.ok(avatarOf({ v: 1, avatar: 'data:image/webp;base64,UklGRg==' }));
});

test('avatarOf rejects anything that is not a plain image data URL', () => {
  for (const avatar of [
    'https://example.com/me.jpg', // no fetching remote images (would leak who looked)
    'data:image/svg+xml;base64,PHN2Zz4=', // svg can carry script
    'data:text/html;base64,PGgxPg==',
    'data:image/jpeg;base64,abc"onerror="x',
    'javascript:alert(1)',
    `data:image/jpeg;base64,${'A'.repeat(MAX_AVATAR_CHARS)}`,
    42, undefined, {},
  ]) assert.equal(avatarOf({ v: 1, avatar }), null, String(avatar).slice(0, 40));
  for (const v of [0, -1, 1.5, 'x', undefined, Number.MAX_VALUE]) assert.equal(avatarOf({ v, avatar: JPEG }), null);
  assert.equal(avatarOf(null), null);
});

test('newer versions win, equal or older ones are ignored', () => {
  assert.equal(isNewer(undefined, { v: 1 }), true);
  assert.equal(isNewer({ v: 2 }, { v: 3 }), true);
  assert.equal(isNewer({ v: 3 }, { v: 3 }), false);
  assert.equal(isNewer({ v: 4 }, { v: 3 }), false);
  assert.equal(isNewer({ v: 4 }, null), false);
});

test('a chat needs my photo until it has this version', () => {
  const mine = { data: JPEG, v: 10 };
  assert.equal(needsProfile(mine, {}, '@bob.veil'), true);
  assert.equal(needsProfile(mine, { '@bob.veil': 10 }, '@bob.veil'), false);
  assert.equal(needsProfile(mine, { '@bob.veil': 9 }, '@bob.veil'), true);
  assert.equal(needsProfile(undefined, {}, '@bob.veil'), false); // never set a photo: nothing to send
  assert.equal(needsProfile({ data: null, v: 11 }, { '@bob.veil': 10 }, '@bob.veil'), true); // removal travels too
});

test('profilePayload round-trips through avatarOf', () => {
  for (const mine of [{ data: JPEG, v: 7 }, { data: null, v: 8 }]) {
    const p = profilePayload(mine);
    assert.equal(p.kind, 'profile');
    assert.deepEqual(avatarOf(p), mine);
  }
});
