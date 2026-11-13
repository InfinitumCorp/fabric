// Status updates, broadcast lists and locked chats. Pure helpers (tested in test/status.test.js);
// the page side is public/status.js.
//
// A status is a text or photo that lasts 24 hours. It goes to each of your chats as an end-to-end
// encrypted control message, like a profile photo: the relay sees one encrypted message per
// device and nothing about what's in it or that it's a status. Viewers tell you they saw it (if
// read receipts are on). A broadcast sends the same message as separate one-to-one messages.
// A locked chat is hidden from the chat list behind a code that never leaves this device.

export const STATUS_TTL = 24 * 3600e3;
export const MAX_STATUS_TEXT = 700;
export const MAX_STATUSES = 30; // of mine at once
export const STATUS_BGS = ['#111820', '#2454dd', '#1f6f5c', '#8a3b2e', '#5b4a8a', '#6b6f75'];
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A received status payload, checked: { sid, text?, bg?, media? } or { sid, del: true }, or null. */
export function statusOf(p) {
  if (!p || p.kind !== 'status' || typeof p.sid !== 'string' || !SID_RE.test(p.sid)) return null;
  if (p.del === true) return { sid: p.sid, del: true };
  const out = { sid: p.sid };
  const text = String(p.text ?? '').slice(0, MAX_STATUS_TEXT).trim();
  if (text) out.text = text;
  if (STATUS_BGS.includes(p.bg)) out.bg = p.bg;
  const m = p.media;
  if (m && typeof m === 'object' && m.type === 'image' && IMG_MIME.has(m.mime) && typeof m.data === 'string' && m.data.length < 200_000 && B64_RE.test(m.data)) {
    out.media = { type: 'image', mime: m.mime, data: m.data, ...(Number.isInteger(m.w) && Number.isInteger(m.h) ? { w: m.w, h: m.h } : {}) };
  }
  if (!out.text && !out.media) return null;
  return out;
}

/** Statuses older than a day are gone. Changes `store` in place; returns how many were removed. */
export function expireStatuses(store, now = Date.now()) {
  if (!store) return 0;
  let n = 0;
  const keep = (list) => (list || []).filter((s) => { const ok = now - s.ts < STATUS_TTL; if (!ok) n++; return ok; });
  store.mine = keep(store.mine);
  for (const h of Object.keys(store.from || {})) {
    store.from[h] = keep(store.from[h]);
    if (!store.from[h].length) delete store.from[h];
  }
  return n;
}

/** Add or remove a contact's status. Returns true when something changed. */
export function applyStatus(store, from, st, ts, now = Date.now()) {
  if (!st || now - ts >= STATUS_TTL) return false;
  store.from ??= {};
  const list = (store.from[from] ??= []);
  const i = list.findIndex((s) => s.sid === st.sid);
  if (st.del) { if (i < 0) return false; list.splice(i, 1); if (!list.length) delete store.from[from]; return true; }
  if (i >= 0) return false;
  list.push({ ...st, ts });
  list.sort((a, b) => a.ts - b.ts);
  return true;
}

/** Contacts with statuses, unseen first, then newest first: [{ handle, list, unseen }]. */
export function statusRows(store) {
  return Object.entries(store?.from || {})
    .map(([handle, list]) => ({ handle, list, unseen: list.some((s) => !s.seen), last: list.at(-1)?.ts || 0 }))
    .sort((a, b) => (b.unseen - a.unseen) || (b.last - a.last));
}

/** Who a new status goes to: one-to-one chats, minus blocked people, bots and anyone excluded. */
export function statusAudience(handles, { blocked = {}, exclude = [], isBot = () => false } = {}) {
  const ex = new Set(exclude);
  return handles.filter((h) => /^@[a-z0-9_]{2,24}\.veil$/.test(h) && !blocked[h] && !ex.has(h) && !isBot(h));
}

// ---------- broadcast lists ----------
export const MAX_BROADCAST = 256;
/** A saved broadcast list, cleaned: { id, name, members } or null. */
export function cleanBroadcast(b) {
  if (!b || typeof b.id !== 'string' || !/^b[a-z0-9]{6,16}$/.test(b.id)) return null;
  const members = [...new Set((b.members || []).filter((h) => /^@[a-z0-9_]{2,24}\.veil$/.test(h)))].slice(0, MAX_BROADCAST);
  if (!members.length) return null;
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || `${members.length} recipients`;
  return { id: b.id, name, members };
}

// ---------- chat lock ----------
export const LOCK_ITER = 200_000;
export const MIN_LOCK_CODE = 4;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** PBKDF2 of the secret code with a random salt. The code itself is never stored. */
export async function lockHash(code, salt = hex(globalThis.crypto.getRandomValues(new Uint8Array(16))), iter = LOCK_ITER) {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(String(code)), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: iter }, key, 256);
  return { salt, iter, hash: hex(bits) };
}
export async function lockCheck(code, lock) {
  if (!lock?.hash) return false;
  const { hash } = await lockHash(code, lock.salt, lock.iter);
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ lock.hash.charCodeAt(i);
  return diff === 0 && hash.length === lock.hash.length;
}
