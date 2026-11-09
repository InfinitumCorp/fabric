// Profile photos. A photo never goes to the relay as a file: it travels inside an end-to-end
// encrypted `profile` message to the people you chat with (and your own other devices), like a
// photo in a chat. The relay only sees an encrypted message of about that size.
//
// Wire payload: { kind: 'profile', v, avatar }  where v is a version (ms timestamp) and avatar is a
// small square JPEG/WebP/PNG data URL, or null when the photo was removed.

export const AVATAR_PX = 256;
export const MAX_AVATAR_CHARS = 96 * 1024; // a 256px JPEG is ~15–30 KB; base64 adds a third
const DATA_URL = /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A validated photo from a profile payload: { data, v } (data null = removed), or null if invalid. */
export function avatarOf(p) {
  if (!p || typeof p !== 'object') return null;
  const v = Number(p.v);
  if (!Number.isSafeInteger(v) || v <= 0) return null;
  if (p.avatar === null) return { data: null, v };
  if (typeof p.avatar !== 'string' || p.avatar.length > MAX_AVATAR_CHARS || !DATA_URL.test(p.avatar)) return null;
  return { data: p.avatar, v };
}

/** True when `inc` should replace `cur` (newer version wins; equal versions are a no-op). */
export function isNewer(cur, inc) {
  return Boolean(inc) && inc.v > (Number(cur?.v) || 0);
}

/** Does the chat `key` still need my current photo (or its removal)? */
export function needsProfile(mine, sentTo, key) {
  return Boolean(mine?.v) && (sentTo?.[key] ?? 0) !== mine.v;
}

/** The payload that shares `mine`. */
export function profilePayload(mine) {
  return { kind: 'profile', v: mine.v, avatar: mine.data ?? null };
}
