// Bot rules shared by the relay's Bot API, the browser client and the tests.
//
// A FabriC++ bot is an ordinary account (its own account key, device and prekeys) that the relay
// runs on behalf of a developer. Messages to a bot are end-to-end encrypted to the bot's device,
// which the relay hosts, so the relay operator and the bot's developer can read them. The client
// says so wherever a bot appears.
//
// Bot messages carry their buttons inside the encrypted payload as `markup`:
//   { inline: [[{ text, data } | { text, url }]] }                         buttons under the message
//   { keyboard: [[{ text }]], resize?, once?, placeholder? }               a keyboard over the composer
//   { remove: true }                                                       take that keyboard away
// Pressing an inline button sends `{ kind: 'bot_cb', qid, target, data }` to the bot only; the bot
// may answer with `{ kind: 'bot_answer', qid, text?, alert? }`.

export const BOT_HANDLE_RE = /^@[a-z0-9_]{1,21}bot\.veil$/;
export const isBotHandle = (h) => typeof h === 'string' && BOT_HANDLE_RE.test(h);
export const FORGE_HANDLE = '@forgebot.veil';

export const MAX_ROWS = 8;
export const MAX_PER_ROW = 8;
export const MAX_BUTTON_TEXT = 64;
export const MAX_CB_DATA = 64; // bytes
export const MAX_COMMANDS = 50;
export const COMMAND_RE = /^[a-z0-9_]{1,32}$/;
const QID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, n);
const bytes = (s) => new TextEncoder().encode(s).length;

function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href.slice(0, 512) : null;
  } catch { return null; }
}

function grid(rows, cell) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) return null;
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length || row.length > MAX_PER_ROW) return null;
    const r = [];
    for (const b of row) {
      const c = cell(b);
      if (!c) return null;
      r.push(c);
    }
    out.push(r);
  }
  return out;
}

function inlineButton(b) {
  if (!b || typeof b !== 'object') return null;
  const text = clean(b.text, MAX_BUTTON_TEXT);
  if (!text) return null;
  if (typeof b.data === 'string' && b.data && bytes(b.data) <= MAX_CB_DATA) return { text, data: b.data };
  const url = b.url !== undefined && safeUrl(b.url);
  if (url) return { text, url };
  return null;
}

function keyButton(b) {
  const text = clean(typeof b === 'string' ? b : b?.text, MAX_BUTTON_TEXT);
  return text ? { text } : null;
}

/** Markup from a payload, checked; null when absent or malformed (malformed is dropped whole). */
export function markupOf(payload) {
  const m = payload?.markup;
  if (!m || typeof m !== 'object') return null;
  if (m.remove === true) return { remove: true };
  if (m.inline !== undefined) {
    const inline = grid(m.inline, inlineButton);
    return inline ? { inline } : null;
  }
  if (m.keyboard !== undefined) {
    const keyboard = grid(m.keyboard, keyButton);
    if (!keyboard) return null;
    const out = { keyboard };
    if (m.resize === true) out.resize = true;
    if (m.once === true) out.once = true;
    const ph = clean(m.placeholder, 64);
    if (ph) out.placeholder = ph;
    return out;
  }
  return null;
}

/**
 * Markup from the Bot API's `reply_markup` (snake_case, like most bot platforms use), converted to
 * the payload form above. Throws with a message a developer can act on.
 */
export function markupFromApi(rm) {
  if (rm === undefined || rm === null) return null;
  if (typeof rm === 'string') {
    try { rm = JSON.parse(rm); } catch { throw new Error('reply_markup is not valid JSON'); }
  }
  if (typeof rm !== 'object') throw new Error('reply_markup must be an object');
  let p;
  if (rm.inline_keyboard) {
    p = { inline: rm.inline_keyboard.map?.((row) => row.map?.((b) => ({ text: b?.text, data: b?.callback_data, url: b?.url }))) };
  } else if (rm.keyboard) {
    p = { keyboard: rm.keyboard, resize: rm.resize_keyboard === true, once: rm.one_time_keyboard === true, placeholder: rm.input_field_placeholder };
  } else if (rm.remove_keyboard === true) {
    p = { remove: true };
  } else throw new Error('reply_markup needs inline_keyboard, keyboard or remove_keyboard');
  const m = markupOf({ markup: p });
  if (!m) throw new Error(`reply_markup is malformed: up to ${MAX_ROWS} rows of ${MAX_PER_ROW} buttons, text up to ${MAX_BUTTON_TEXT} characters, callback_data up to ${MAX_CB_DATA} bytes, url http(s) only`);
  return m;
}

/** A callback press from a client, checked; null when malformed. */
export function callbackOf(payload) {
  if (payload?.kind !== 'bot_cb' || !QID_RE.test(payload.qid) || !ID_RE.test(payload.target)) return null;
  if (typeof payload.data !== 'string' || !payload.data || bytes(payload.data) > MAX_CB_DATA) return null;
  return { qid: payload.qid, target: payload.target, data: payload.data };
}

/** A bot's answer to a press, checked; null when malformed. */
export function answerOf(payload) {
  if (payload?.kind !== 'bot_answer' || !QID_RE.test(payload.qid)) return null;
  return { qid: payload.qid, text: clean(payload.text, 200), alert: payload.alert === true };
}

/** Bot commands (`[{ command, description }]`), checked; throws on bad input. */
export function commandsFrom(list) {
  if (!Array.isArray(list) || list.length > MAX_COMMANDS) throw new Error(`commands must be a list of up to ${MAX_COMMANDS}`);
  const seen = new Set();
  return list.map((c) => {
    const command = String(c?.command ?? '').replace(/^\//, '').toLowerCase();
    const description = clean(c?.description, 256);
    if (!COMMAND_RE.test(command)) throw new Error(`command "${command}" must be 1-32 of a-z, 0-9 and _`);
    if (!description) throw new Error(`command /${command} needs a description`);
    if (seen.has(command)) throw new Error(`command /${command} is listed twice`);
    seen.add(command);
    return { command, description };
  });
}

/**
 * The /command at the start of a text, if any: { command, args, target } where target is the bot
 * named with /cmd@namebot (groups). Commands are case-insensitive.
 */
export function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([a-z0-9_]{1,24}))?(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { command: m[1].toLowerCase(), target: m[2] ? `@${m[2]}.veil` : null, args: (m[3] || '').trim() };
}

/** Does a group message concern this bot (for privacy mode)? Commands, mentions and replies to it. */
export function concernsBot(text, botHandle, replyFrom = null) {
  if (replyFrom === botHandle) return true;
  const cmd = parseCommand(text);
  if (cmd) return !cmd.target || cmd.target === botHandle;
  const name = botHandle.slice(1, -'.veil'.length);
  return new RegExp(`(^|[^a-z0-9_])[+@]${name}(\\.veil)?($|[^a-z0-9_])`, 'i').test(String(text ?? ''));
}

/** Deep links: fabric://bot/<name>?start=<param> or <relay>/?bot=<name>&start=<param>. */
export const START_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function parseBotLink(href) {
  let u;
  try { u = new URL(String(href)); } catch { return null; }
  let name = null;
  if (u.protocol === 'fabric:') {
    // fabric://bot/echobot  (host "bot")  or  fabric:bot/echobot
    const parts = `${u.host}${u.pathname}`.replace(/^\/+/, '').split('/');
    if (parts[0] === 'bot') name = parts[1];
  } else if (u.protocol === 'https:' || u.protocol === 'http:') {
    name = u.searchParams.get('bot');
  }
  const handle = name ? `@${String(name).toLowerCase().replace(/^[+@]/, '').replace(/\.veil$/, '')}.veil` : null;
  if (!isBotHandle(handle)) return null;
  const start = u.searchParams.get('start');
  return { handle, start: start && START_PARAM_RE.test(start) ? start : null };
}
