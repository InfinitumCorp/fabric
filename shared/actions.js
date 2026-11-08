// Message actions: replies, forwards, edits, deletions and reactions.
//
// All of them travel inside the end-to-end encryption like an ordinary message, so the relay
// learns nothing new. A reply or forward is a text message with extra fields; edit, delete and
// react are `{ kind: 'action', act, target, ... }` payloads that change a message already in the
// thread. Only the author of a message may edit or delete it for everyone; anyone in the chat may
// react, with at most one reaction per person.

export const MAX_TEXT = 4000;
export const MAX_QUOTE = 200;
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const ACTS = new Set(['edit', 'delete', 'react']);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const clip = (s, n) => String(s ?? '').slice(0, n);

/** A reaction is a short emoji-like string: up to 8 code points, no letters, digits or spaces. */
export function isReaction(s) {
  if (typeof s !== 'string' || !s || [...s].length > 8) return false;
  return !/[\p{L}\p{N}\s<>]/u.test(s);
}

/** The quote carried by a reply, built from the message being answered. */
export function quoteOf(m) {
  if (!m || !ID_RE.test(m.id)) return null;
  return { id: m.id, from: String(m.from), text: m.deleted ? '' : clip(m.text, MAX_QUOTE) };
}

/** A received quote, checked and trimmed; null when absent or malformed. */
export function replyOf(payload) {
  const r = payload?.reply;
  if (!r || typeof r !== 'object' || !ID_RE.test(r.id) || typeof r.from !== 'string') return null;
  return { id: r.id, from: clip(r.from, 64), text: clip(r.text, MAX_QUOTE) };
}

/** Fields a text payload may carry besides the text itself. */
export function extrasOf(payload) {
  const out = {};
  const reply = replyOf(payload);
  if (reply) out.reply = reply;
  if (payload?.fwd === true) out.forwarded = true;
  return out;
}

/** Build an action payload. `peer` is set only on copies sent to my own other devices. */
export function actionPayload(act, target, { text, emoji, peer } = {}) {
  if (!ACTS.has(act) || !ID_RE.test(target)) throw new Error('bad action');
  const p = { kind: 'action', act, target };
  if (act === 'edit') p.text = clip(text, MAX_TEXT);
  if (act === 'react') p.emoji = emoji ? String(emoji) : '';
  if (peer) p.peer = peer;
  return p;
}

/**
 * Apply an action from `actor` to a thread (an array of messages, changed in place).
 * Returns the changed message, or null when the action is invalid, not allowed, or its target
 * isn't here (any of which is ignored silently, like a message that can't be decrypted).
 */
export function applyAction(thread, actor, payload, ts = Date.now()) {
  if (!Array.isArray(thread) || payload?.kind !== 'action' || !ACTS.has(payload.act)) return null;
  const m = thread.find((x) => x.id === payload.target && x.from !== '@system');
  if (!m) return null;
  if (payload.act === 'react') {
    if (m.deleted) return null;
    const e = payload.emoji;
    if (e !== '' && !isReaction(e)) return null;
    m.reactions ??= {};
    if (e === '') delete m.reactions[actor]; else m.reactions[actor] = e;
    if (!Object.keys(m.reactions).length) delete m.reactions;
    return m;
  }
  if (m.from !== actor) return null; // only the author edits or deletes for everyone
  if (payload.act === 'edit') {
    if (m.deleted) return null;
    const text = clip(payload.text, MAX_TEXT);
    if (!text.trim()) return null;
    m.text = text;
    m.edited = ts;
    delete m.tr; delete m.sentTr; // an old translation no longer matches
    return m;
  }
  // delete for everyone: keep a tombstone so the conversation still reads in order
  m.deleted = ts;
  m.text = '';
  delete m.tr; delete m.sentTr; delete m.reactions; delete m.edited;
  return m;
}

/** Reactions grouped for display: [{ emoji, count, mine }], most used first. */
export function reactionSummary(m, me) {
  const by = new Map();
  for (const [who, e] of Object.entries(m?.reactions || {})) {
    const g = by.get(e) || { emoji: e, count: 0, mine: false };
    g.count++;
    if (who === me) g.mine = true;
    by.set(e, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}
