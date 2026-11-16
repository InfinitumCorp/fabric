// Everyday messenger features: shared location, contact cards, view-once photos, @mentions,
// starred messages, blocking and message info. Like replies and polls, each one is a field inside
// the end-to-end encrypted message (or a local flag), so the relay learns nothing new. Older
// clients show the plain-text fallback that travels as the message text.
//
// Pure helpers (tested in test/wa.test.js); the page side is public/wa.js.

export const HANDLE_RE = /^@[a-z0-9_]{2,24}\.veil$/;
const clip = (s, n) => String(s ?? '').slice(0, n);
const oneLine = (s, n) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n);

// ---------- location ----------
/** A shared location: { lat, lon, acc?, label? }, or null when absent or out of range. */
export function locOf(payload) {
  const l = payload?.loc;
  if (!l || typeof l !== 'object') return null;
  const lat = Number(l.lat), lon = Number(l.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const out = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
  const acc = Number(l.acc);
  if (Number.isFinite(acc) && acc > 0 && acc < 1e6) out.acc = Math.round(acc);
  const label = oneLine(l.label, 80);
  if (label) out.label = label;
  return out;
}
/** A link that opens the spot on a map. Nothing is fetched until the person taps it. */
export const mapsUrl = (l) => `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lon}#map=17/${l.lat}/${l.lon}`;
export const locFallback = (l) => `📍 ${l.label ? l.label + ' · ' : ''}Location: ${l.lat}, ${l.lon}\n${mapsUrl(l)}`;

// ---------- contact cards ----------
/** A shared contact: { handle, name? }, or null. */
export function cardOf(payload) {
  const c = payload?.card;
  if (!c || typeof c !== 'object' || typeof c.handle !== 'string' || !HANDLE_RE.test(c.handle)) return null;
  const name = oneLine(c.name, 60);
  return { handle: c.handle, ...(name ? { name } : {}) };
}
export const cardFallback = (c) => `👤 ${c.name ? c.name + ' · ' : ''}${c.handle}`;

// ---------- view once ----------
/** View-once applies to photos only; anything else is sent normally. */
export const onceOf = (payload, media) => payload?.once === true && media?.type === 'image';
/** What's left of a view-once photo after it's opened: the label, never the picture. */
export function spendOnce(m, ts = Date.now()) {
  if (!m?.once || !m.media) return false;
  delete m.media.data;
  m.opened ??= ts;
  return true;
}

// ---------- @mentions ----------
const MENTION_RE = /@[a-z0-9_]{2,24}\.veil\b/g;
/** Handles mentioned in `text` that are members of the chat (in order, once each). */
export function mentionsIn(text, members = []) {
  const set = new Set(members);
  const out = [];
  for (const h of String(text ?? '').match(MENTION_RE) || []) if (set.has(h) && !out.includes(h)) out.push(h);
  return out;
}
export const mentionsMe = (text, me) => Boolean(me) && (String(text ?? '').match(MENTION_RE) || []).includes(me);
/** The "@na" being typed at the caret, or null: what the member picker filters on. */
export function mentionQuery(text, caret = String(text ?? '').length) {
  const before = String(text ?? '').slice(0, caret);
  const m = before.match(/(?:^|\s)@([a-z0-9_.]{0,30})$/i);
  return m ? m[1].toLowerCase() : null;
}
/** Replace the "@na" before the caret with a full handle and a space. Returns { text, caret }. */
export function insertMention(text, caret, handle) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  const next = before.slice(0, at) + handle + ' ';
  return { text: next + text.slice(caret), caret: next.length };
}

// ---------- blocking ----------
export const isBlocked = (db, h) => Boolean(db?.blocked?.[h]);
/** Payload kinds a blocked person still gets through: none from a direct chat; groups are unchanged. */
export function dropFromBlocked(db, from, payload) {
  if (!isBlocked(db, from)) return false;
  return payload?.gid === undefined && !payload?.group;
}

// ---------- message info ----------
/** Per-recipient status of a message I sent: [{ who, read? }] for groups, or one row for a 1:1. */
export function messageInfo(m, members = [], me = '') {
  if (!m || m.from !== me) return [];
  const others = members.filter((h) => h !== me);
  if (others.length) return others.map((who) => ({ who, ...(m.readBy?.[who] ? { read: m.readBy[who] } : {}) }));
  return [{ who: null, ...(m.read ? { read: m.read } : {}) }];
}

// ---------- extras ----------
/** Fields of these features a received text payload may carry, checked. */
export function waExtrasOf(payload) {
  const out = {};
  const loc = locOf(payload); if (loc) out.loc = loc;
  const card = cardOf(payload); if (card) out.card = card;
  if (payload?.once === true && payload?.media?.type === 'image') out.once = true;
  return out;
}
