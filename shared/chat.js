// Messenger rules shared by the browser client and the tests: media attachments, read receipts,
// typing indicators, groups, and how the chat list is ordered.
//
// Everything here travels inside the end-to-end encryption. A photo, voice message or file rides
// in the message payload itself (so the relay stores nothing it could read later), which is why
// attachments are capped: the encrypted, sealed envelope must fit the relay's 512 KB frame.

import { isValidHandle } from './crypto.js';

// ---------- media ----------
export const MAX_MEDIA_BYTES = 140_000; // raw bytes; ~3x after base64 + ratchet + sealed sender
export const MAX_VOICE_SECONDS = 120;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const AUDIO_MIME = /^audio\/(webm|ogg|mp4|mpeg|aac|wav)(;\s*codecs=[\w.,"' -]{1,40})?$/;
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]{1,60}$/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Bytes encoded by a base64 string (without decoding it). */
export function b64Bytes(s) {
  if (typeof s !== 'string' || !s || s.length % 4 || !B64_RE.test(s)) return -1;
  return (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
}

/** A file name safe to show and to offer as a download name. */
export function safeFileName(name) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*‪-‮⁦-⁩]/g, '_').replace(/^\.+/, '').trim();
  return (n || 'file').slice(0, 80);
}

/**
 * A received attachment, checked; null when absent or malformed.
 * { type: 'image'|'audio'|'file', mime, name, size, data (base64), w?, h?, dur? }
 */
export function mediaOf(payload) {
  const m = payload?.media;
  if (!m || typeof m !== 'object') return null;
  const size = b64Bytes(m.data);
  if (size <= 0 || size > MAX_MEDIA_BYTES) return null;
  const mime = String(m.mime || '').toLowerCase();
  const out = { type: m.type, mime, size, data: m.data, name: safeFileName(m.name) };
  if (m.type === 'image') {
    if (!IMAGE_MIME.has(mime)) return null;
    const w = Number(m.w), h = Number(m.h);
    if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 8192 && h <= 8192) Object.assign(out, { w, h });
  } else if (m.type === 'audio') {
    if (!AUDIO_MIME.test(mime)) return null;
    const dur = Number(m.dur);
    if (Number.isFinite(dur) && dur > 0) out.dur = Math.min(Math.round(dur * 10) / 10, MAX_VOICE_SECONDS);
  } else if (m.type === 'file') {
    if (!MIME_RE.test(mime)) out.mime = 'application/octet-stream';
  } else return null;
  return out;
}

export function fmtDuration(s) {
  const t = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
export function fmtBytes(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** One-line description for chat-list previews and quotes. */
export function mediaLabel(media, text = '') {
  if (!media) return text;
  const base = media.type === 'image' ? '📷 Photo'
    : media.type === 'audio' ? `🎤 Voice message${media.dur ? ` (${fmtDuration(media.dur)})` : ''}`
      : `📎 ${media.name}`;
  return text ? `${base} · ${text}` : base;
}

// ---------- read receipts ----------
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function receiptPayload(ids, peer) {
  const clean = [...new Set(ids)].filter((id) => ID_RE.test(id)).slice(0, 200);
  return { kind: 'receipt', ids: clean, ...(peer ? { peer } : {}) };
}

/**
 * The contact read my messages: mark them read. Only messages I sent in this thread count, and a
 * receipt never un-reads anything. Returns how many changed.
 */
export function applyReceipt(thread, me, payload, ts = Date.now()) {
  if (!Array.isArray(thread) || payload?.kind !== 'receipt' || !Array.isArray(payload.ids)) return 0;
  const ids = new Set(payload.ids.filter((id) => typeof id === 'string'));
  let n = 0;
  for (const m of thread) {
    if (m.from === me && ids.has(m.id) && !m.read) { m.read = ts; n++; }
  }
  return n;
}

/** Messages from others I haven't sent a receipt for yet. */
export function unreadFrom(thread, me) {
  return (thread || []).filter((m) => m.from !== me && m.from !== '@system' && !m.receiptSent && !m.deleted);
}

// ---------- typing ----------
export const TYPING_SEND_EVERY = 3_000;
export const TYPING_SHOW_FOR = 6_000;
/** A typing signal is shown only if it is recent: queued ones that arrive late are ignored. */
export const freshTyping = (sentTs, now = Date.now()) => Number.isFinite(sentTs) && now - sentTs < TYPING_SHOW_FOR && sentTs - now < 30_000;

// ---------- groups ----------
// A group is a list of members that every member's device keeps. A group message is sent pairwise
// (end-to-end, to every device of every member), carrying the group id; there is no server-side
// group. Any member may rename the group or add people; anyone may leave.
export const MAX_GROUP = 64;
export const GROUP_ID_RE = /^[A-Za-z0-9_-]{12,32}$/;
export const groupKey = (id) => `#${id}`;
export const isGroupKey = (k) => typeof k === 'string' && k.startsWith('#') && GROUP_ID_RE.test(k.slice(1));
export const groupIdOf = (k) => (isGroupKey(k) ? k.slice(1) : null);
const clipName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);

/** A group description from a payload, checked; null when malformed. */
export function groupOf(payload) {
  const g = payload?.group;
  if (!g || typeof g !== 'object' || !GROUP_ID_RE.test(g.id)) return null;
  if (!Array.isArray(g.members)) return null;
  const members = [...new Set(g.members)].filter(isValidHandle);
  if (members.length < 2 || members.length > MAX_GROUP || members.length !== g.members.length) return null;
  return { id: g.id, name: clipName(g.name) || 'Group', members };
}

export function newGroup(id, name, creator, members) {
  const all = [...new Set([creator, ...members])].filter(isValidHandle);
  if (!GROUP_ID_RE.test(id) || all.length < 2 || all.length > MAX_GROUP) throw new Error('bad group');
  return { id, name: clipName(name) || 'Group', members: all };
}

/**
 * A group message or update arrived from `actor`. Returns the group as this device should now keep
 * it, or null to ignore the message. A sender who isn't a member (by my copy) is ignored — except
 * when I don't know the group yet and the sender lists both of us, which is how I learn of it.
 * ops: 'msg' (just a message; my copy wins), 'rename', 'add', 'leave'.
 */
export function mergeGroup(mine, incoming, actor, me, op = 'msg') {
  if (!incoming) return null;
  if (!mine) {
    if (!incoming.members.includes(actor)) return null;
    if (op === 'leave') return null;
    if (!incoming.members.includes(me)) return null;
    return { ...incoming, members: [...incoming.members] };
  }
  if (mine.id !== incoming.id || !mine.members.includes(actor)) return null;
  const g = { ...mine, members: [...mine.members] };
  if (op === 'rename') g.name = incoming.name;
  else if (op === 'add') {
    for (const h of incoming.members) if (!g.members.includes(h) && g.members.length < MAX_GROUP) g.members.push(h);
  } else if (op === 'leave') g.members = g.members.filter((h) => h !== actor);
  return g;
}

// ---------- chat list ----------
/**
 * Order chat keys for the list: pinned first (most recently pinned on top), then by last activity.
 * Archived chats are left out unless `archived` is true, in which case only they are returned.
 */
export function orderChats(keys, prefs = {}, lastTs = () => 0, { archived = false } = {}) {
  return keys
    .filter((k) => Boolean(prefs[k]?.archived) === archived)
    .sort((a, b) => {
      const pa = prefs[a]?.pinned || 0, pb = prefs[b]?.pinned || 0;
      if (pa || pb) return pb - pa;
      return lastTs(b) - lastTs(a);
    });
}
export const MAX_PINNED = 5;
