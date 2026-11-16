// Large groups and channels ("spaces"), shared by the relay and the client.
//
// A space is held by the relay: its member list, roles and posts. That is the trade-off that
// makes thousands of members possible (one copy of each post instead of one per member device).
//
//   kind        visibility  who posts            post bodies the relay stores
//   'group'     'private'   every member          ciphertext (space key, held only by members)
//   'channel'   'private'   owner and admins      ciphertext (space key, held only by subscribers)
//   'channel'   'public'    owner and admins      PLAINTEXT: anyone may read it, so there is no
//                                                 one to encrypt it to. Never end-to-end encrypted.
//
// Small groups (up to 64 people, shared/chat.js) are unchanged: no relay-side group at all.
// Private spaces: the key travels in the invite link's #fragment (never sent to the relay) and,
// after someone is removed, an admin's device makes a new key epoch and sends it to the remaining
// members over their end-to-end encrypted one-to-one sessions.

import { isValidHandle } from './crypto.js';

export const SPACE_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
export const INVITE_RE = /^[A-Za-z0-9_-]{16,32}$/;
export const KINDS = ['group', 'channel'];
export const ROLES = ['owner', 'admin', 'member'];
export const MAX_POST_TEXT = 4096;
export const MAX_ADMINS = 50;
// Topics a public channel can pick. Sponsored posts are matched to the topic: that is all the
// context an ad gets (see server/ads.js).
export const TOPICS = ['news', 'tech', 'finance', 'sports', 'music', 'gaming', 'education', 'travel', 'food', 'science', 'culture', 'other'];
// Reactions are a fixed set so the relay can count them without free text.
export const REACTIONS = ['👍', '❤️', '🔥', '🎉', '😂', '😮', '😢', '👎'];

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, n);
export const cleanName = (s) => clip(s, 64);
export const cleanAbout = (s) => clip(s, 280);

/** A public channel's address, typed as +name.veil or @name.veil; stored as @name.veil. */
export function channelHandle(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/^\+/, '@');
  const h = t.startsWith('@') ? t : `@${t}`;
  const full = /\.veil$/.test(h) ? h : `${h}.veil`;
  return isValidHandle(full) ? full : null;
}
export const showHandle = (h) => String(h || '').replace(/^@/, '+');

/** Can `role` do `action` in a space of `kind`? */
export function can(role, action, kind) {
  if (!ROLES.includes(role)) return false;
  switch (action) {
    case 'post': return kind === 'group' || role !== 'member';
    case 'react': case 'read': case 'leave': return true;
    case 'delete_post': case 'invite': case 'remove': case 'edit': case 'rotate': return role !== 'member';
    case 'promote': case 'demote': case 'delete_space': return role === 'owner';
    default: return false;
  }
}

/**
 * A post body as the relay keeps it. Public channels: { text } (plaintext, up to MAX_POST_TEXT).
 * Private spaces: { e, iv, ct } (AES-GCM under key epoch e). Returns null when malformed.
 * `maxBytes` is the poster's upload entitlement (ciphertext may carry a photo or file).
 */
export function postBody(body, visibility, maxBytes) {
  if (!body || typeof body !== 'object') return null;
  if (visibility === 'public') {
    const text = clip(body.text, MAX_POST_TEXT);
    if (!text) return null;
    return { text };
  }
  const { e, iv, ct } = body;
  if (!Number.isInteger(e) || e < 0 || e > 1e6) return null;
  if (typeof iv !== 'string' || !/^[A-Za-z0-9+/=]{16,24}$/.test(iv)) return null;
  if (typeof ct !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(ct) || ct.length > Math.ceil(maxBytes * 4 / 3) + 64) return null;
  return { e, iv, ct };
}
