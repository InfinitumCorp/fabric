// Message actions: replies, forwards, edits, deletions and reactions.
//
// All of them travel inside the end-to-end encryption like an ordinary message, so the relay
// learns nothing new. A reply or forward is a text message with extra fields; edit, delete and
// react are `{ kind: 'action', act, target, ... }` payloads that change a message already in the
// thread. Only the author of a message may edit or delete it for everyone; anyone in the chat may
// react, with at most one reaction per person.
//
// v0.20 adds pinned messages (`pin`, anyone in the chat), polls (a text message with a `poll`
// field; `vote` by anyone in the chat, `close` by its author) and disappearing messages (a `ttl`
// field in seconds). Older clients ignore actions and fields they don't know: they see a poll as
// its plain-text fallback, and keep disappearing messages.

export const MAX_TEXT = 4000;
export const MAX_QUOTE = 200;
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const ACTS = new Set(['edit', 'delete', 'react', 'pin', 'vote', 'close']);
export const MAX_POLL_OPTIONS = 10;
export const MAX_POLL_Q = 300;
export const MAX_POLL_OPTION = 100;
/** Disappearing-message timers, in seconds (0 = off). */
export const TTL_CHOICES = [0, 3600, 86400, 7 * 86400, 30 * 86400];
export const ttlLabel = (s) => ({ 0: 'Off', 3600: '1 hour', 86400: '1 day', [7 * 86400]: '1 week', [30 * 86400]: '1 month' })[s] || 'Off';
export const isTtl = (s) => Number.isInteger(s) && s > 0 && TTL_CHOICES.includes(s);
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
  if (payload?.silent === true) out.silent = true; // sent without sound: no alert on arrival
  const poll = pollOf(payload);
  if (poll) out.poll = poll;
  if (isTtl(payload?.ttl)) out.ttl = payload.ttl;
  return out;
}

/** A poll carried by a message, checked and trimmed; null when absent or malformed. */
export function pollOf(payload) {
  const p = payload?.poll;
  if (!p || typeof p !== 'object' || !Array.isArray(p.options)) return null;
  const q = clip(p.q, MAX_POLL_Q).trim();
  const options = p.options.slice(0, MAX_POLL_OPTIONS).map((o) => clip(o, MAX_POLL_OPTION).trim());
  if (!q || options.length < 2 || options.some((o) => !o) || new Set(options).size !== options.length) return null;
  return { q, options, ...(p.multi === true ? { multi: true } : {}) };
}

/** The text older clients show for a poll. */
export function pollFallback(poll) {
  return `📊 ${poll.q}\n${poll.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n(A poll: update FabriC++ to vote.)`;
}

/** Votes counted for display: { counts: [n per option], voters, mine: [indexes], closed }. */
export function pollSummary(m, me) {
  const counts = (m?.poll?.options || []).map(() => 0);
  let voters = 0;
  for (const choices of Object.values(m?.votes || {})) {
    voters++;
    for (const i of choices) if (i < counts.length) counts[i]++;
  }
  return { counts, voters, mine: m?.votes?.[me] || [], closed: Boolean(m?.pollClosed) };
}

/** Disappearing messages whose time is up are removed. Returns the number removed. */
export function expireThread(thread, now = Date.now()) {
  if (!Array.isArray(thread)) return 0;
  let n = 0;
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (isTtl(m.ttl) && m.ts + m.ttl * 1000 <= now) { thread.splice(i, 1); n++; }
  }
  return n;
}

/** Build an action payload. `peer` is set only on copies sent to my own other devices. */
export function actionPayload(act, target, { text, emoji, peer, on, choices } = {}) {
  if (!ACTS.has(act) || !ID_RE.test(target)) throw new Error('bad action');
  const p = { kind: 'action', act, target };
  if (act === 'edit') p.text = clip(text, MAX_TEXT);
  if (act === 'react') p.emoji = emoji ? String(emoji) : '';
  if (act === 'pin') p.on = Boolean(on);
  if (act === 'vote') p.choices = Array.isArray(choices) ? choices : [];
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
  if (payload.act === 'pin') { // anyone in the chat pins or unpins, for everyone in it
    if (m.deleted) return null;
    if (payload.on === true) m.pinned = ts; else if (payload.on === false) delete m.pinned; else return null;
    return m;
  }
  if (payload.act === 'vote') { // one ballot per person, replaced on each vote; [] takes it back
    if (m.deleted || !m.poll || m.pollClosed || !Array.isArray(payload.choices)) return null;
    const n = m.poll.options.length;
    const c = [...new Set(payload.choices)];
    if (c.some((i) => !Number.isInteger(i) || i < 0 || i >= n) || (!m.poll.multi && c.length > 1)) return null;
    m.votes ??= {};
    if (c.length) m.votes[actor] = c.sort((a, b) => a - b); else delete m.votes[actor];
    if (!Object.keys(m.votes).length) delete m.votes;
    return m;
  }
  if (m.from !== actor) return null; // only the author edits, deletes or closes a poll for everyone
  if (payload.act === 'close') {
    if (m.deleted || !m.poll || m.pollClosed) return null;
    m.pollClosed = ts;
    return m;
  }
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
  delete m.poll; delete m.votes; delete m.pollClosed; delete m.pinned;
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
