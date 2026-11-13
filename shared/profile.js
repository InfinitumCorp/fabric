// Profile photos. A photo never goes to the relay as a file: it travels inside an end-to-end
// encrypted `profile` message to the people you chat with (and your own other devices), like a
// photo in a chat. The relay only sees an encrypted message of about that size.
//
// Wire payload: { kind: 'profile', v, avatar }  where v is a version (ms timestamp) and avatar is a
// small square JPEG/WebP/PNG data URL, or null when the photo was removed. `about` is an optional
// short line of text ("Available", "At work"). Each payload is a full snapshot: the newest wins.

export const AVATAR_PX = 256;
export const MAX_AVATAR_CHARS = 96 * 1024; // a 256px JPEG is ~15–30 KB; base64 adds a third
export const MAX_ABOUT = 139;
const DATA_URL = /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]+={0,2}$/;

/** An about line: trimmed, one line, no control characters, at most MAX_ABOUT characters; '' when none. */
export function cleanAbout(s) {
  if (typeof s !== 'string') return '';
  return [...s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_ABOUT).join('').trim();
}

/** A validated profile from a payload: { data, v, about? } (data null = no photo), or null if invalid. */
export function avatarOf(p) {
  if (!p || typeof p !== 'object') return null;
  const v = Number(p.v);
  if (!Number.isSafeInteger(v) || v <= 0) return null;
  const about = cleanAbout(p.about);
  const extra = about ? { about } : {};
  if (p.avatar === null || p.avatar === undefined) return { data: null, v, ...extra };
  if (typeof p.avatar !== 'string' || p.avatar.length > MAX_AVATAR_CHARS || !DATA_URL.test(p.avatar)) return null;
  return { data: p.avatar, v, ...extra };
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
  return { kind: 'profile', v: mine.v, avatar: mine.data ?? null, ...(mine.about ? { about: cleanAbout(mine.about) } : {}) };
}
