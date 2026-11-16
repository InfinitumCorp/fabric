// FabriC++ Bot API: developers register a bot with +forgebot.veil, get a token, and drive the bot
// over HTTP, receiving updates by long polling (getUpdates) or by webhook.
//
//   POST https://<relay>/bot<token>/<method>     JSON, form or query parameters
//   -> { ok: true, result } | { ok: false, error_code, description, parameters? }
//
// Each bot is a real FabriC++ account whose device runs here (server/bot-device.js): people's
// messages are end-to-end encrypted to that device, decrypted here and handed to the developer as
// updates; the developer's replies are encrypted here to each recipient device. So a bot's messages
// are readable by the relay host and by the bot's developer, and the client says exactly that.
// Updates are kept in memory only (not on disk) until the bot confirms them or 24 hours pass.
//
// Sandboxing: a bot can only write to people who wrote to it first and to groups it is in; it
// can't look anyone up or read any other chat. Sends, API calls and webhook targets are limited:
// per-bot and per-chat rate limits, markup and media size checks, webhooks over https to public
// addresses only, one long poll at a time, at most MAX_BOTS_PER_OWNER bots per person.

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { keyId, newMessageId } from '../shared/crypto.js';
import { mediaOf, groupOf, mergeGroup, MAX_MEDIA_BYTES } from '../shared/chat.js';
import { replyOf, MAX_TEXT } from '../shared/actions.js';
import {
  isBotHandle, FORGE_HANDLE, markupFromApi, callbackOf, commandsFrom, parseCommand, concernsBot,
} from '../shared/bots.js';
import { Buckets } from './limits.js';

const apiMarkup = (rm) => { try { return markupFromApi(rm); } catch (e) { throw new ApiError(400, `Bad Request: ${e.message}`); } };
import { newBotState, createBotDevice } from './bot-device.js';
import { createForge } from './bot-forge.js';

export const MAX_BOTS_PER_OWNER = 20;
const MAX_QUEUE = 1000;
const UPDATE_TTL_MS = 24 * 3600_000;
const MAX_POLL_S = 50;
const CB_TTL_MS = 10 * 60_000;
const SENT_KEEP = 2000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_BODY = Math.ceil(MAX_MEDIA_BYTES * 1.4) + 20_000;
const UPDATE_TYPES = ['message', 'callback_query', 'my_chat_member'];

export function botsFromEnv(env = process.env, dataFile = null) {
  if (env.FABRIC_BOTS === '0') return null;
  const stateDir = env.FABRIC_BOTS_DIR || (dataFile ? path.join(path.dirname(dataFile), 'bots') : null);
  return { stateDir, allowLocalWebhooks: env.FABRIC_BOTS_LOCAL_WEBHOOKS === '1' };
}

class ApiError extends Error {
  constructor(code, description, parameters) { super(description); Object.assign(this, { code, parameters }); }
}
const bad = (d) => new ApiError(400, `Bad Request: ${d}`);

const sha = (s) => createHash('sha256').update(String(s)).digest();
const rid = (n = 18) => randomBytes(n).toString('base64url');
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/** Private, loopback, link-local and other non-public addresses (webhooks may not point there). */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9')
    || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}

/**
 * The bot platform.
 * @param {object} o
 * @param {string|null} o.stateDir   folder for bot keys and settings (secret); null = memory (tests)
 * @param {Function} o.isTaken       (handle) => true when a FabriC++ account already has that handle
 * @param {boolean} [o.allowLocalWebhooks]  allow http://localhost webhooks (development, tests)
 */
export async function createBots({ stateDir = null, isTaken = () => false, allowLocalWebhooks = false, log = console.log, now = Date.now, fetchImpl = globalThis.fetch, lookup = dns.lookup } = {}) {
  const hubSecret = rid(24); // lets the hub's own bot sockets past per-IP limits on loopback
  const files = stateDir ? { index: path.join(stateDir, 'index.json'), dev: (h) => path.join(stateDir, `${h.slice(1)}.json`) } : null;
  const writeJson = (file, obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file); // never half a file: that would lose every session
  };
  const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

  // index: { v, bots: { [handle]: meta }, retired: [handles] }
  const index = (files && readJson(files.index)) || { v: 1, bots: {}, retired: [] };
  const saveIndex = () => { if (files) writeJson(files.index, index); };
  const devStates = new Map(); // handle -> device state
  async function stateFor(handle, name) {
    let s = devStates.get(handle) || (files && readJson(files.dev(handle)));
    if (!s) s = await newBotState(handle, name);
    devStates.set(handle, s);
    if (files) writeJson(files.dev(handle), s);
    return s;
  }
  const saverFor = (handle) => () => { if (files) writeJson(files.dev(handle), devStates.get(handle)); };

  const live = new Map(); // handle -> runtime { device, queue, nextId, poll, hook, sent, cbs }
  const byTokenId = new Map(); // tokenId -> handle
  for (const [h, m] of Object.entries(index.bots)) byTokenId.set(m.tokenId, h);

  const limits = {
    api: new Buckets(60, 30, { now }),           // Bot API calls per bot
    send: new Buckets(30, 30, { now }),          // messages per bot
    chat: new Buckets(5, 1, { now }),            // messages per bot per private chat
    group: new Buckets(20, 20 / 60, { now }),    // messages per bot per group
  };
  let relayUrl = null;
  let wsOptions = {};
  let stopped = false;

  // ---------- registry ----------
  function issueToken(meta) {
    const tokenId = rid(6);
    const secret = rid(24);
    if (meta.tokenId) byTokenId.delete(meta.tokenId);
    meta.tokenId = tokenId;
    meta.tokenHash = sha(secret).toString('base64');
    byTokenId.set(tokenId, meta.handle);
    return `${tokenId}:${secret}`;
  }

  function botForToken(token) {
    const m = /^([A-Za-z0-9_-]{8}):([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
    const handle = m && byTokenId.get(m[1]);
    const meta = handle && index.bots[handle];
    if (!meta || !sameHash(sha(m[2]), Buffer.from(meta.tokenHash, 'base64'))) return null;
    return meta;
  }

  const ownedBy = (owner) => Object.values(index.bots).filter((b) => b.owner === owner);

  function checkNewHandle(handle) {
    if (!isBotHandle(handle)) return 'A bot address ends in "bot", like +weatherbot or +shop_helper_bot, with 3-24 letters, digits or _.';
    if (handle === FORGE_HANDLE || index.bots[handle] || index.retired.includes(handle) || isTaken(handle)) return 'That address is taken. Try another.';
    return null;
  }

  /** Register a bot for `owner` (a FabriC++ handle). Returns { meta, token }. */
  async function create(owner, handle, name) {
    const why = checkNewHandle(handle);
    if (why) throw new Error(why);
    if (ownedBy(owner).length >= MAX_BOTS_PER_OWNER) throw new Error(`You can have up to ${MAX_BOTS_PER_OWNER} bots.`);
    const meta = {
      handle, owner, name: String(name || handle.slice(1, -5)).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Bot',
      about: '', commands: [], privacy: true, created: now(), webhook: null, users: {},
    };
    const token = issueToken(meta);
    index.bots[handle] = meta;
    await stateFor(handle, meta.name);
    saveIndex();
    if (relayUrl) await run(meta);
    log(`[bots] created a bot`); // no handles or owners in the log
    return { meta, token };
  }

  function rotate(handle) {
    const meta = index.bots[handle];
    const token = issueToken(meta);
    saveIndex();
    const r = live.get(handle);
    if (r?.poll) endPoll(r, conflict('the token was replaced'));
    return token;
  }

  function update(handle, fields) {
    const meta = index.bots[handle];
    if ('about' in fields) meta.about = String(fields.about || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim().slice(0, 512);
    if ('name' in fields) meta.name = String(fields.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || meta.name;
    if ('commands' in fields) meta.commands = commandsFrom(fields.commands);
    if ('privacy' in fields) meta.privacy = fields.privacy !== false;
    saveIndex();
    return meta;
  }

  /** Delete a bot: its device goes offline for good and its address is retired (never reissued). */
  function remove(handle) {
    const meta = index.bots[handle];
    if (!meta) return false;
    const r = live.get(handle);
    if (r) { if (r.poll) endPoll(r, conflict('the bot was deleted')); r.device.stop(); live.delete(handle); }
    byTokenId.delete(meta.tokenId);
    delete index.bots[handle];
    index.retired.push(handle);
    saveIndex();
    devStates.delete(handle);
    if (files) fs.rmSync(files.dev(handle), { force: true });
    return true;
  }

  /** Public profile for clients. Only bots registered here count (not every handle ending in bot). */
  function info(handle) {
    if (handle === FORGE_HANDLE && forge) return { bot: true, system: true, handle, ...forge.profile };
    const m = index.bots[handle];
    if (!m) return { bot: false };
    return { bot: true, handle, name: m.name, about: m.about, commands: m.commands, privacy: m.privacy, online: Boolean(live.get(handle)?.device.online) };
  }

  // ---------- updates ----------
  const chatOfPayload = (from, payload, botState) => {
    const g = groupOf(payload);
    if (g) return { id: `#${g.id}`, type: 'group', title: g.name, members: g.members };
    return { id: from, type: 'private' };
  };

  function push(r, type, body) {
    if (r.allowed && !r.allowed.includes(type)) return;
    r.queue.push({ update_id: r.nextId++, [type]: body, _at: now() });
    while (r.queue.length > MAX_QUEUE) r.queue.shift();
    flush(r);
  }

  function flush(r) {
    if (r.meta.webhook) return pumpHook(r);
    if (r.poll && r.queue.length) endPoll(r, null);
  }

  function pending(r) {
    const cut = now() - UPDATE_TTL_MS;
    while (r.queue.length && r.queue[0]._at < cut) r.queue.shift();
    return r.queue;
  }
  const publicUpdate = ({ _at, ...u }) => u;

  /** A decrypted payload from a person (or a group) arrived at a bot's device. */
  function onBotMessage(r, { from, id, ts, payload }) {
    const meta = r.meta;
    const st = devStates.get(meta.handle);
    const who = { id: from, is_bot: Boolean(index.bots[from]) };

    if (payload.kind === 'group') {
      const inc = groupOf(payload);
      if (!inc) return;
      const mine = st.groups[inc.id];
      const op = ['create', 'rename', 'add', 'leave'].includes(payload.op) ? payload.op : null;
      const next = op && mergeGroup(mine, inc, from, meta.handle, op === 'create' ? 'msg' : op);
      if (!next) return;
      r.device.noteGroup(next);
      if (!mine) push(r, 'my_chat_member', { chat: { id: `#${next.id}`, type: 'group', title: next.name }, from: who, date: Math.floor(ts / 1000), status: 'member' });
      return;
    }

    const cb = callbackOf(payload);
    if (cb) {
      const chat = payload.gid !== undefined && st.groups[String(payload.gid)]
        ? { id: `#${payload.gid}`, type: 'group', title: st.groups[String(payload.gid)].name } : { id: from, type: 'private' };
      r.cbs.set(cb.qid, { from, at: now() });
      for (const [q, c] of r.cbs) if (now() - c.at > CB_TTL_MS) r.cbs.delete(q);
      return push(r, 'callback_query', { id: cb.qid, from: who, message: { message_id: cb.target, chat }, data: cb.data });
    }

    if (payload.kind !== 'text') return; // typing, receipts, reactions, calls: not bot business
    const text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_TEXT) : '';
    const media = mediaOf(payload);
    if (!text && !media) return;
    const chat = chatOfPayload(from, payload, st);
    const reply = replyOf(payload);
    if (chat.type === 'group') {
      const g = groupOf(payload);
      const mine = st.groups[g.id];
      const next = mergeGroup(mine, g, from, meta.handle, 'msg');
      if (!next || !next.members.includes(meta.handle)) return;
      if (!mine) {
        r.device.noteGroup(next);
        push(r, 'my_chat_member', { chat: { id: chat.id, type: 'group', title: next.name }, from: who, date: Math.floor(ts / 1000), status: 'member' });
      }
      // privacy mode: only commands, mentions and replies to the bot reach it
      if (meta.privacy && !concernsBot(text, meta.handle, reply?.from)) return;
      delete chat.members;
    } else {
      meta.users[from] = now(); // they wrote first: the bot may write back
      saveIndex();
    }
    const msg = { message_id: id, date: Math.floor(ts / 1000), from: who, chat };
    if (text) msg.text = text;
    const cmd = parseCommand(text);
    if (cmd) {
      msg.entities = [{ type: 'bot_command', offset: 0, length: text.trim().split(/\s/)[0].length }];
      if (cmd.command === 'start' && cmd.args) msg.start_param = cmd.args.slice(0, 64);
    }
    if (reply) msg.reply_to_message = { message_id: reply.id, from: { id: reply.from }, text: reply.text };
    if (media) msg.media = { type: media.type, mime: media.mime, name: media.name, size: media.size, data: media.data, ...(media.w ? { width: media.w, height: media.h } : {}), ...(media.dur ? { duration: media.dur } : {}) };
    push(r, 'message', msg);
  }

  // ---------- long polling ----------
  const conflict = (why) => new ApiError(409, `Conflict: ${why}`);
  function endPoll(r, err) {
    const p = r.poll;
    if (!p) return;
    r.poll = null;
    clearTimeout(p.timer);
    p.done(err, err ? null : pending(r).slice(0, p.limit).map(publicUpdate));
  }

  function getUpdates(r, q) {
    if (r.meta.webhook) throw conflict("can't use getUpdates while a webhook is set; call deleteWebhook first");
    const offset = Number(q.offset) || 0;
    if (offset) r.queue = r.queue.filter((u) => u.update_id >= offset);
    if (q.allowed_updates !== undefined) r.allowed = allowedFrom(q.allowed_updates);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 100));
    const timeout = Math.min(MAX_POLL_S, Math.max(0, Number(q.timeout) || 0));
    const now_ = pending(r);
    if (now_.length || !timeout) return Promise.resolve(now_.slice(0, limit).map(publicUpdate));
    if (r.poll) endPoll(r, conflict('terminated by another getUpdates request'));
    return new Promise((resolve, reject) => {
      r.poll = {
        limit,
        done: (err, list) => (err ? reject(err) : resolve(list)),
        timer: setTimeout(() => endPoll(r, null), timeout * 1000),
      };
    });
  }

  function allowedFrom(v) {
    let list = v;
    if (typeof v === 'string') { try { list = JSON.parse(v); } catch { list = v.split(','); } }
    if (!Array.isArray(list) || !list.length) return null;
    return list.map(String).filter((t) => UPDATE_TYPES.includes(t));
  }

  // ---------- webhooks ----------
  async function checkHookUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { throw bad('webhook url is not a URL'); }
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.username || u.password) throw bad('webhook url may not contain a user name or password');
    if (allowLocalWebhooks && localHost && (u.protocol === 'http:' || u.protocol === 'https:')) return u;
    if (u.protocol !== 'https:') throw bad('webhook url must be https');
    if (localHost || net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))) throw bad('webhook url must be a public address');
    if (!allowLocalWebhooks) {
      let addrs;
      try { addrs = await lookup(u.hostname, { all: true }); } catch { throw bad('webhook host does not resolve'); }
      if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw bad('webhook url must be a public address');
    }
    return u;
  }

  async function pumpHook(r) {
    if (r.hook.busy || !r.meta.webhook || stopped) return;
    r.hook.busy = true;
    try {
      while (r.meta.webhook && pending(r).length && !stopped) {
        const u = r.queue[0];
        const hook = r.meta.webhook;
        let ok = false;
        try {
          await checkHookUrl(hook.url); // again at delivery: DNS may have changed
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), WEBHOOK_TIMEOUT_MS);
          const res = await fetchImpl(hook.url, {
            method: 'POST', redirect: 'manual', signal: ctl.signal,
            headers: { 'content-type': 'application/json', ...(hook.secret ? { 'x-fabric-bot-api-secret-token': hook.secret } : {}) },
            body: JSON.stringify(publicUpdate(u)),
          }).finally(() => clearTimeout(t));
          ok = res.status >= 200 && res.status < 300;
          if (!ok) r.hook.lastError = `HTTP ${res.status}`;
        } catch (e) {
          r.hook.lastError = e.name === 'AbortError' ? 'timed out' : String(e.message || e).slice(0, 120);
        }
        if (ok) {
          if (r.queue[0] === u) r.queue.shift();
          r.hook.fails = 0;
        } else {
          r.hook.lastErrorAt = now();
          r.hook.fails = (r.hook.fails || 0) + 1;
          const wait = Math.min(60_000, 1000 * 2 ** Math.min(6, r.hook.fails - 1));
          clearTimeout(r.hook.retry);
          r.hook.retry = setTimeout(() => pumpHook(r), wait);
          r.hook.retry.unref?.();
          break;
        }
      }
    } finally { r.hook.busy = false; }
  }

  // ---------- sending ----------
  function canWrite(r, chat) {
    const st = devStates.get(r.meta.handle);
    if (typeof chat !== 'string' || !chat) throw bad('chat_id is required');
    if (chat.startsWith('#')) {
      if (!st.groups[chat.slice(1)]?.members.includes(r.meta.handle)) throw new ApiError(403, 'Forbidden: the bot is not a member of that group');
      return chat;
    }
    const h = chat.startsWith('+') ? `@${chat.slice(1)}` : chat;
    if (!r.meta.users[h]) throw new ApiError(403, "Forbidden: the bot can't start a chat; that person has to write to it first");
    return h;
  }

  function throttle(r, chat) {
    const w = limits.send.take(r.meta.handle) || (chat.startsWith('#') ? limits.group : limits.chat).take(`${r.meta.handle}|${chat}`);
    if (w) throw new ApiError(429, `Too Many Requests: retry after ${w}`, { retry_after: w });
  }

  const textOf = (v, field = 'text', { required = true } = {}) => {
    const t = v === undefined || v === null ? '' : String(v);
    if (required && !t.trim()) throw bad(`${field} is empty`);
    if (t.length > MAX_TEXT) throw bad(`${field} is longer than ${MAX_TEXT} characters`);
    return t;
  };

  function remember(r, id, chat, text) {
    r.sent.set(id, { chat, text });
    if (r.sent.size > SENT_KEEP) r.sent.delete(r.sent.keys().next().value);
  }

  async function sendMessage(r, q, media = null) {
    const chat = canWrite(r, q.chat_id);
    const text = textOf(media ? q.caption : q.text, media ? 'caption' : 'text', { required: !media });
    const markup = apiMarkup(q.reply_markup);
    throttle(r, chat);
    const payload = { kind: 'text', text };
    if (markup) payload.markup = markup;
    if (media) payload.media = media;
    const replyTo = q.reply_to_message_id ?? q.reply_parameters?.message_id;
    if (replyTo) payload.reply = { id: String(replyTo), from: String(q.reply_to_from || ''), text: String(q.reply_to_text || '').slice(0, 200) };
    if (payload.reply && !/^[A-Za-z0-9_-]{8,64}$/.test(payload.reply.id)) throw bad('reply_to_message_id is not a message id');
    if (payload.reply && !payload.reply.from) payload.reply.from = chat.startsWith('#') ? '' : chat;
    const { id, ts } = await r.device.send(chat, payload).catch((e) => { throw new ApiError(400, `Bad Request: ${e.message}`); });
    remember(r, id, chat, text);
    const out = { message_id: id, date: Math.floor(ts / 1000), chat: { id: chat, type: chat.startsWith('#') ? 'group' : 'private' }, from: { id: r.meta.handle, is_bot: true } };
    if (text) out.text = text;
    if (markup) out.reply_markup = q.reply_markup;
    return out;
  }

  function mediaFrom(q, type) {
    const field = { image: 'photo', file: 'document', audio: 'audio' }[type];
    const data = String(q[field] ?? (type === 'audio' ? q.voice : '') ?? '').replace(/^data:[^,]*,/, '');
    const mime = String(q.mime_type || (type === 'image' ? 'image/jpeg' : type === 'audio' ? 'audio/ogg' : 'application/octet-stream'));
    const m = mediaOf({ media: { type, mime, name: q.file_name || field, data, w: q.width, h: q.height, dur: q.duration } });
    if (!m) throw bad(`${field} must be base64 data up to ${Math.floor(MAX_MEDIA_BYTES / 1000)} KB${type === 'image' ? ' (jpeg, png, webp or gif)' : type === 'audio' ? ' (ogg, webm, mp4, mpeg, aac or wav)' : ''}`);
    return { type: m.type, mime: m.mime, name: m.name, data: m.data, ...(m.w ? { w: m.w, h: m.h } : {}), ...(m.dur ? { dur: m.dur } : {}) };
  }

  async function edit(r, q, { markupOnly = false } = {}) {
    const chat = canWrite(r, q.chat_id);
    const target = String(q.message_id || '');
    const known = r.sent.get(target);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(target)) throw bad('message_id is required');
    const text = markupOnly ? known?.text : textOf(q.text);
    if (!text) throw bad('that message is too old to edit without text; pass text');
    const markup = apiMarkup(q.reply_markup);
    throttle(r, chat);
    await r.device.send(chat, { kind: 'action', act: 'edit', target, text, markup: markup || null });
    remember(r, target, chat, text);
    return { message_id: target, chat: { id: chat }, text, ...(markup ? { reply_markup: q.reply_markup } : {}) };
  }

  // ---------- the API ----------
  const methods = {
    getMe: (r) => ({ id: r.meta.handle, is_bot: true, handle: `+${r.meta.handle.slice(1)}`, name: r.meta.name, about: r.meta.about, privacy: r.meta.privacy, can_join_groups: true, can_read_all_group_messages: !r.meta.privacy }),
    getUpdates,
    async setWebhook(r, q) {
      if (!q.url) return methods.deleteWebhook(r, q);
      const u = await checkHookUrl(q.url);
      const secret = q.secret_token ? String(q.secret_token) : null;
      if (secret && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw bad('secret_token may use A-Z, a-z, 0-9, _ and -, up to 256 characters');
      if (q.drop_pending_updates === true || q.drop_pending_updates === 'true') r.queue = [];
      if (q.allowed_updates !== undefined) r.allowed = allowedFrom(q.allowed_updates);
      r.meta.webhook = { url: u.href, secret };
      saveIndex();
      if (r.poll) endPoll(r, conflict('a webhook was set'));
      r.hook.fails = 0;
      pumpHook(r);
      return true;
    },
    deleteWebhook(r, q) {
      r.meta.webhook = null;
      clearTimeout(r.hook.retry);
      if (q.drop_pending_updates === true || q.drop_pending_updates === 'true') r.queue = [];
      saveIndex();
      return true;
    },
    getWebhookInfo: (r) => ({
      url: r.meta.webhook?.url || '', has_custom_certificate: false, pending_update_count: pending(r).length,
      ...(r.hook.lastErrorAt ? { last_error_date: Math.floor(r.hook.lastErrorAt / 1000), last_error_message: r.hook.lastError } : {}),
      ...(r.allowed ? { allowed_updates: r.allowed } : {}),
    }),
    sendMessage: (r, q) => sendMessage(r, q),
    sendPhoto: (r, q) => sendMessage(r, q, mediaFrom(q, 'image')),
    sendDocument: (r, q) => sendMessage(r, q, mediaFrom(q, 'file')),
    sendAudio: (r, q) => sendMessage(r, q, mediaFrom(q, 'audio')),
    sendVoice: (r, q) => sendMessage(r, q, mediaFrom(q, 'audio')),
    editMessageText: (r, q) => edit(r, q),
    editMessageReplyMarkup: (r, q) => edit(r, q, { markupOnly: true }),
    async deleteMessage(r, q) {
      const chat = canWrite(r, q.chat_id);
      const target = String(q.message_id || '');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(target)) throw bad('message_id is required');
      throttle(r, chat);
      await r.device.send(chat, { kind: 'action', act: 'delete', target });
      r.sent.delete(target);
      return true;
    },
    async sendChatAction(r, q) {
      const chat = canWrite(r, q.chat_id);
      await r.device.send(chat, { kind: 'typing' }).catch(() => {});
      return true;
    },
    async answerCallbackQuery(r, q) {
      const qid = String(q.callback_query_id || '');
      const cb = r.cbs.get(qid);
      if (!cb) throw bad('query is too old or the id is wrong');
      r.cbs.delete(qid);
      const text = q.text === undefined ? '' : String(q.text).slice(0, 200);
      await r.device.send(cb.from, { kind: 'bot_answer', qid, ...(text ? { text } : {}), ...(q.show_alert === true || q.show_alert === 'true' ? { alert: true } : {}) });
      return true;
    },
    async leaveChat(r, q) {
      const chat = canWrite(r, q.chat_id);
      if (!chat.startsWith('#')) throw bad('only groups can be left');
      const st = devStates.get(r.meta.handle);
      const g = st.groups[chat.slice(1)];
      await r.device.send(chat, { kind: 'group', op: 'leave', group: { id: g.id, name: g.name, members: g.members } });
      r.device.forgetGroup(g.id);
      return true;
    },
    setMyCommands(r, q) {
      let list = q.commands;
      if (typeof list === 'string') { try { list = JSON.parse(list); } catch { throw bad('commands is not valid JSON'); } }
      try { update(r.meta.handle, { commands: list }); } catch (e) { throw bad(e.message); }
      return true;
    },
    getMyCommands: (r) => r.meta.commands,
    deleteMyCommands(r) { update(r.meta.handle, { commands: [] }); return true; },
    setMyDescription(r, q) { update(r.meta.handle, { about: q.description ?? q.about ?? '' }); return true; },
    getMyDescription: (r) => ({ description: r.meta.about }),
    setMyName(r, q) { update(r.meta.handle, { name: q.name }); return true; },
    getMyName: (r) => ({ name: r.meta.name }),
    getChat(r, q) {
      const chat = canWrite(r, q.chat_id);
      if (!chat.startsWith('#')) return { id: chat, type: 'private' };
      const g = devStates.get(r.meta.handle).groups[chat.slice(1)];
      return { id: chat, type: 'group', title: g.name, members: g.members };
    },
  };

  async function bodyOf(req, url) {
    const q = Object.fromEntries(url.searchParams);
    if (req.method !== 'POST') return q;
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) throw new ApiError(413, 'Request Entity Too Large');
    }
    if (!body) return q;
    const type = String(req.headers['content-type'] || '');
    if (type.includes('application/x-www-form-urlencoded')) return { ...q, ...Object.fromEntries(new URLSearchParams(body)) };
    try { return { ...q, ...JSON.parse(body) }; } catch { throw bad('body is not valid JSON'); }
  }

  /** HTTP: /bot<token>/<method>. Returns false when the path is not the Bot API. */
  async function handleHttp(req, res, url) {
    const m = /^\/bot([^/]{1,80})\/([A-Za-z]{1,40})$/.exec(url.pathname);
    if (!m) return false;
    const reply = (code, obj, headers = {}) => {
      if (res.writableEnded) return;
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify(obj));
    };
    const fail = (e) => {
      const code = e instanceof ApiError ? e.code : 500;
      if (!(e instanceof ApiError)) log(`[bots] error in a Bot API call: ${e.stack || e}`);
      reply(code, { ok: false, error_code: code, description: e instanceof ApiError ? e.message : 'Internal Server Error', ...(e.parameters ? { parameters: e.parameters } : {}) },
        e.parameters?.retry_after ? { 'retry-after': String(e.parameters.retry_after) } : {});
    };
    try {
      const meta = botForToken(decodeURIComponent(m[1]));
      if (!meta) throw new ApiError(401, 'Unauthorized: unknown or replaced token');
      const r = live.get(meta.handle);
      if (!r) throw new ApiError(503, 'Service Unavailable: the bot is starting');
      const method = methods[m[2]];
      if (!method || !Object.hasOwn(methods, m[2])) throw new ApiError(404, `Not Found: no method ${m[2]}`);
      const w = limits.api.take(meta.handle);
      if (w) throw new ApiError(429, `Too Many Requests: retry after ${w}`, { retry_after: w });
      const q = await bodyOf(req, url);
      req.on('close', () => { if (r.poll && !res.writableEnded && m[2] === 'getUpdates') endPoll(r, conflict('connection closed')); });
      const result = await method(r, q);
      reply(200, { ok: true, result });
    } catch (e) { fail(e); }
    return true;
  }

  // ---------- running ----------
  async function run(meta) {
    const handle = meta.handle;
    const state = await stateFor(handle, meta.name);
    const r = { meta, queue: [], nextId: 1, poll: null, hook: {}, sent: new Map(), cbs: new Map(), allowed: null };
    r.device = createBotDevice({ state, save: saverFor(handle), log, now, tag: 'bots', onMessage: (msg) => onBotMessage(r, msg) });
    live.set(handle, r);
    const ready = r.device.start(relayUrl, { ...wsOptions, headers: { 'x-fabric-bot-hub': hubSecret } });
    if (meta.webhook) pumpHook(r);
    return ready;
  }

  let forge = null;
  const api = {
    hubSecret,
    create, rotate, update, remove, info, checkNewHandle,
    ownedBy, get: (h) => index.bots[h] || null,
    /** May this account key register this handle? Bot handles belong to the bots registered here. */
    mayRegister(handle, accountJwk) {
      if (handle === FORGE_HANDLE) return Boolean(forge) && keyId(forge.accountKey) === keyId(accountJwk);
      const s = devStates.get(handle);
      return Boolean(index.bots[handle] && s && keyId(s.account.publicJwk) === keyId(accountJwk));
    },
    handleHttp,
    /** Start every bot's device against the relay at this URL; resolves once all are signed in. */
    async start(url, opts = {}) {
      relayUrl = url;
      wsOptions = opts;
      const forgeState = await stateFor(FORGE_HANDLE, 'Forge');
      forge = createForge({ hub: api, state: forgeState, save: saverFor(FORGE_HANDLE), log, now });
      const all = [forge.device.start(url, { ...opts, headers: { 'x-fabric-bot-hub': hubSecret } })];
      for (const meta of Object.values(index.bots)) all.push(run(meta));
      await Promise.all(all);
    },
    /** Wait for messages received so far to be handled (tests). */
    idle: async () => { await forge?.device.idle(); for (const r of live.values()) await r.device.idle(); },
    stop() {
      stopped = true;
      forge?.device.stop();
      for (const r of live.values()) {
        r.device.stop();
        clearTimeout(r.hook.retry);
        if (r.poll) endPoll(r, conflict('the relay is shutting down'));
      }
    },
    newMessageId,
  };
  return api;
}
