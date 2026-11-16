// Automatic translation: the decisions, as pure functions (the page does the detecting and
// translating on the device, in public/ai.js). Nothing here, and nothing that calls it, sends
// message text anywhere: detection and translation run on this device, after decryption.
//
// Preferences (kept in the encrypted vault, db.ai):
//   auto     true | false | undefined: translate every chat and channel automatically.
//            undefined = never asked: on by default, and the user is asked once, the first
//            time something actually gets translated.
//   off      { [chatKey]: true }: chats and channels where auto translation is switched off.
//   translate{ [chatKey]: true }: chats switched on by hand while auto is off.
//   noOffer  { [chatKey]: true }: chats where "reply in their language?" was turned down.

/** Bring old preferences (translateAll) up to date. Mutates and returns `p`. */
export function normalizePrefs(p = {}) {
  p.translate ??= {};
  p.off ??= {};
  p.out ??= {};
  p.noOffer ??= {};
  if ('translateAll' in p) {
    // someone who turned on "Translate every chat" already said yes
    if (p.translateAll === true && p.auto === undefined) p.auto = true;
    delete p.translateAll;
  }
  return p;
}

/** Is incoming text in this chat (or channel) translated automatically? */
export function translatingIn(p, key) {
  if (!key) return false;
  if (p.off?.[key]) return false;
  if (p.translate?.[key]) return true;
  return p.auto !== false;
}

/** Flip one chat's switch. Returns the new state for that chat. Mutates `p`. */
export function toggleChat(p, key) {
  normalizePrefs(p);
  const on = translatingIn(p, key);
  delete p.off[key];
  delete p.translate[key];
  if (on) {
    if (p.auto !== false) p.off[key] = true; // auto stays on elsewhere
  } else if (p.auto === false) p.translate[key] = true; // just this one
  return translatingIn(p, key);
}

/** Set auto translation for everything; per-chat choices that now match the default go away. */
export function setAuto(p, on) {
  normalizePrefs(p);
  p.auto = Boolean(on);
  if (p.auto) p.translate = {}; else p.off = {};
  return p;
}

/** Should the one-time question ("keep translating automatically?") be asked now? */
export const shouldAsk = (p) => p.auto === undefined;

/**
 * The line under a translated message.
 * { label, action }: "Translated from Spanish" + "Show original", or "Hide original" when open.
 */
export function noteFor(tr, { open = false, name = (c) => c } = {}) {
  if (!tr?.from) return null;
  return { label: `Translated from ${name(tr.from)}`, action: open ? 'Hide original' : 'Show original' };
}

/**
 * Is a translation that was started for `text` still right for the message? (It may have been
 * edited or deleted while the model ran.)
 */
export const stillCurrent = (m, text) => Boolean(m) && !m.deleted && m.text === text;

/**
 * The language the others in a chat write in, if it isn't mine: the most common detected
 * language of their last 20 messages (ties go to the latest). null when unknown or mine.
 */
export function theirLanguage(thread, me, target) {
  const counts = new Map();
  let latest = null;
  for (const m of (thread || []).filter((x) => x.from !== me && x.from !== '@system' && !x.deleted).slice(-20)) {
    const l = m.tr?.from || m.sentTr?.from || m.lang;
    if (!l) continue;
    counts.set(l, (counts.get(l) || 0) + 1);
    latest = l;
  }
  if (!counts.size) return null;
  const top = Math.max(...counts.values());
  const best = counts.get(latest) === top ? latest : [...counts].find(([, n]) => n === top)[0];
  return best === target ? null : best;
}

/** Offer to reply in their language? Only in a translated chat, once, when nothing's chosen. */
export function offerReplyIn(p, key, theirs, { languages = [] } = {}) {
  if (!theirs || !translatingIn(p, key)) return null;
  if (p.out?.[key] || p.noOffer?.[key]) return null;
  if (languages.length && !languages.includes(theirs)) return null;
  return theirs;
}

/** A short fingerprint of a text, so a cached translation is dropped if the text changes. */
export function textHash(s) {
  let h = 0x811c9dc5;
  const t = String(s ?? '');
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + t.length;
}

/**
 * A translation cache for posts in channels and large groups (they're not stored per message
 * like chats): { [key]: { h, from, text, at } }, kept to the `max` most recently used.
 */
export function cacheGet(cache, key, text) {
  const c = cache?.[key];
  return c && c.h === textHash(text) ? c : null;
}
export function cachePut(cache, key, text, tr, { max = 400, now = Date.now() } = {}) {
  cache[key] = { h: textHash(text), from: tr.from, text: tr.text, at: now };
  const keys = Object.keys(cache);
  if (keys.length > max) {
    keys.sort((a, b) => cache[a].at - cache[b].at);
    for (const k of keys.slice(0, keys.length - max)) delete cache[k];
  }
  return cache;
}
