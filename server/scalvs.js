// Scalvs: SCALVS.ai as a FabriC++ contact. Text +scalvs.veil like anyone else and it runs the task
// and replies in the same chat.
//
// Scalvs is an ordinary FabriC++ device, not a relay feature: it has its own account key, device
// keys, signed device list and prekeys, signs in over the relay's WebSocket like the browser client,
// and talks Double Ratchet (with sealed sender) to each device of each person who writes to it. The
// relay still only stores and forwards ciphertext. The only thing the relay does for Scalvs is
// reserve the handle, so nobody else can register @scalvs.veil.
//
// Its keys and ratchet state are in a JSON file next to the relay's database (data/scalvs.json).
// Like data/fabric.db, that file is secret: whoever holds it can read what people send Scalvs.

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { generateUserIdentity, generateSigningKey, ownershipProof, privateOf, newMessageId, keyId } from '../shared/crypto.js';
import { signDeviceList, verifyDeviceList, newDeviceId, deviceAddr, findDevice } from '../shared/devices.js';
import { SessionManager, emptyStore } from '../shared/session.js';
import { peekSealed, openSealed, isDeliveryKey } from '../shared/sealed.js';
import { receiptPayload } from '../shared/chat.js';
import { runTask } from './scalvs-tasks.js';

export const SCALVS_HANDLE = '@scalvs.veil';
const SEEN_KEEP = 2000;
const TASKS_PER_WINDOW = 20;    // per account
const TASK_WINDOW_MS = 10 * 60_000;
const REMINDER_TICK_MS = 5_000;
const LIST_TTL_MS = 10 * 60_000; // re-check a contact's device list this often

export function scalvsFromEnv(env = process.env, dataFile = null) {
  if (env.FABRIC_SCALVS === '0') return null;
  const stateFile = env.FABRIC_SCALVS_STATE || (dataFile ? path.join(path.dirname(dataFile), 'scalvs.json') : null);
  return { stateFile };
}

/** Create Scalvs's account (account key + one device) on first start, or load it. */
async function loadState(stateFile) {
  if (stateFile && fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const account = await generateSigningKey();
  const device = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(account.privateJwk, {
    handle: SCALVS_HANDLE, version: 1, account: account.publicJwk,
    devices: [{ id: device.id, name: 'Scalvs', dh: device.keys.dh.publicJwk, sig: device.keys.sig.publicJwk, addedAt: Date.now() }],
  });
  return { v: 1, handle: SCALVS_HANDLE, account, device, list, sessions: emptyStore(), contacts: {}, seen: [], reminders: [] };
}

/**
 * Load (or make) Scalvs's identity. The relay needs the account key before it listens, to reserve
 * the handle; call start(url) once the relay is up.
 * @param {object} o
 * @param {string|null} o.stateFile  where keys and ratchet state live; null keeps them in memory (tests)
 * @param {object|null} [o.ai]       { ask(handle, text), note, warm? } from scalvs-ai.js (Claude) or scalvs-local.js
 *                                   (open model), or null for built-in tasks only
 */
export async function createScalvs({ stateFile = null, ai = null, log = console.log, now = Date.now, reconnectMs = 1000 } = {}) {
  const state = await loadState(stateFile);
  const save = () => {
    if (!stateFile) return;
    // write-then-rename, so a crash never leaves half a file (that would lose every session)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  };
  save();

  const me = { handle: state.handle, deviceId: state.device.id, addr: deviceAddr(state.handle, state.device.id) };
  let ws = null;
  let stopped = false;
  let registered = false;
  let deliveryKey = null;
  let refSeq = 0;
  const pending = new Map(); // ref -> { resolve, reject, timer }
  const windows = new Map(); // handle -> [timestamps]
  let work = Promise.resolve(); // envelopes are handled one at a time, in order
  const readyWaiters = [];

  const sm = new SessionManager({
    handle: me.handle, deviceId: me.deviceId, identity: state.device.keys, store: state.sessions,
    fetchBundle: async (addr) => (await request({ type: 'bundle', addr }, 'bundle')).bundle,
    onChange: save, // ratchet state is on disk before any ciphertext made from it leaves
  });

  function wsSend(obj) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function request(obj, type, timeoutMs = 10_000) {
    const ref = `s${++refSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(ref); reject(new Error('relay timed out')); }, timeoutMs);
      pending.set(ref, { type, resolve, reject, timer });
      wsSend({ ...obj, ref });
    });
  }

  // ---------- contacts: signed device lists, account key pinned on first contact ----------
  async function listOf(handle, { force = false } = {}) {
    const c = state.contacts[handle];
    if (c && !force && now() - c.checkedAt < LIST_TTL_MS) return c.list.payload;
    const { list } = await request({ type: 'lookup', handle }, 'directory');
    const payload = await verifyDeviceList(list, { handle, account: c?.account ?? null, minVersion: c?.list.payload.version ?? 0 });
    state.contacts[handle] = { ...c, account: payload.account, list, checkedAt: now() };
    save();
    return payload;
  }

  async function deviceOf(handle, deviceId) {
    let dev = state.contacts[handle] && findDevice(state.contacts[handle].list.payload, deviceId);
    if (!dev) dev = findDevice(await listOf(handle, { force: true }), deviceId);
    return dev;
  }

  // ---------- receiving ----------
  const seenKey = (env) => `${env.from}#${env.fromDevice}|${env.id}`;
  function markSeen(env) {
    state.seen.push(seenKey(env));
    if (state.seen.length > SEEN_KEEP) state.seen.splice(0, state.seen.length - SEEN_KEEP);
  }

  async function unseal(env) {
    const mine = findDevice(state.list.payload, me.deviceId);
    const myDh = privateOf(state.device.keys.dh);
    const peeked = await peekSealed({ sealed: env.sealed, me: me.addr, myDh, myDhPub: mine.dh });
    const dev = await deviceOf(peeked.from, peeked.fromDevice);
    if (!dev) throw new Error('sender device not on its signed list');
    return openSealed(peeked, { myDh, senderDh: dev.dh }); // fails unless that device made it
  }

  /** Decrypt one envelope; returns { from, fromDevice, id, payload } or null. */
  async function open(raw) {
    const env = raw.sealed ? await unseal(raw) : raw;
    if (env.from === me.handle) return null; // Scalvs has one device; nothing to sync
    if (state.seen.includes(seenKey(env))) return null; // redelivered: its message key is spent
    const dev = await deviceOf(env.from, env.fromDevice);
    if (!dev) return null;
    let payload;
    try {
      payload = await sm.decrypt(env, { dh: dev.dh, sig: dev.sig });
    } finally {
      markSeen(env);
      save();
    }
    if (isDeliveryKey(payload?.dk)) state.contacts[env.from].dk = payload.dk;
    return { from: env.from, fromDevice: env.fromDevice, id: env.id, payload };
  }

  async function onDeliver(raw) {
    let msg = null;
    try { msg = await open(raw); } catch (e) { log(`[scalvs] dropped an envelope: ${e.message}`); }
    wsSend({ type: 'got', id: raw.id }); // state is saved (or the envelope is unreadable): let the relay delete it
    if (!msg || msg.payload?.kind !== 'text') return; // typing, receipts, reactions, calls: nothing to do
    if (msg.payload.group) return; // Scalvs works in direct chats; group messages are ignored
    const text = typeof msg.payload.text === 'string' ? msg.payload.text : '';
    if (!text.trim()) return reply(msg.from, 'I read text messages. Send help to see what I can do.');
    await sendTo(msg.from, receiptPayload([msg.id])).catch(() => {});
    if (!allowTask(msg.from)) return reply(msg.from, 'You\'re sending tasks faster than I can take them. Try again in a few minutes.');
    await sendTo(msg.from, { kind: 'typing' }).catch(() => {});
    const result = await runTask(text, {
      handle: msg.from,
      now: now(),
      ai: ai ? (t) => ai.ask(msg.from, t) : null,
      aiNote: ai?.note,
      reminders: remindersFor(msg.from),
    });
    log(`[scalvs] task ${result.kind}`); // never the text or who asked
    await reply(msg.from, result.reply);
  }

  function allowTask(handle) {
    const t = now();
    const recent = (windows.get(handle) || []).filter((x) => t - x < TASK_WINDOW_MS);
    if (recent.length >= TASKS_PER_WINDOW) { windows.set(handle, recent); return false; }
    recent.push(t);
    windows.set(handle, recent);
    return true;
  }

  // ---------- sending ----------
  /** Encrypt one payload to every device of a contact and hand the copies to the relay. */
  async function sendTo(handle, payload) {
    const list = await listOf(handle);
    const id = newMessageId();
    const ts = now();
    const out = [];
    for (const d of list.devices) {
      try { out.push(await sm.encrypt(deviceAddr(handle, d.id), payload, { id, ts })); } catch (e) { log(`[scalvs] could not reach a device: ${e.message}`); }
    }
    // sm.encrypt saved the advanced ratchets (onChange) before anything is sent
    for (const envelope of out) wsSend({ type: 'send', envelope });
    return out.length;
  }

  const reply = (handle, text) => sendTo(handle, { kind: 'text', text, ...(deliveryKey ? { dk: deliveryKey } : {}) })
    .catch((e) => log(`[scalvs] reply failed: ${e.message}`));

  // ---------- reminders (kept in the state file until due) ----------
  function remindersFor(handle) {
    return {
      add: (at, text) => { state.reminders.push({ handle, at, text }); save(); return state.reminders.length; },
      list: () => state.reminders.filter((r) => r.handle === handle).sort((a, b) => a.at - b.at),
      clear: () => {
        const before = state.reminders.length;
        state.reminders = state.reminders.filter((r) => r.handle !== handle);
        save();
        return before - state.reminders.length;
      },
    };
  }

  const reminderTimer = setInterval(() => {
    if (!registered) return;
    const due = state.reminders.filter((r) => r.at <= now());
    if (!due.length) return;
    state.reminders = state.reminders.filter((r) => r.at > now());
    save();
    for (const r of due) work = work.then(() => reply(r.handle, `⏰ Reminder: ${r.text}`));
  }, REMINDER_TICK_MS);
  reminderTimer.unref();

  // ---------- connection ----------
  async function onRelay(m) {
    const p = m.ref && pending.get(m.ref);
    if (p && (m.type === p.type || m.type === 'error')) {
      pending.delete(m.ref);
      clearTimeout(p.timer);
      return m.type === 'error' ? p.reject(new Error(m.error)) : p.resolve(m);
    }
    switch (m.type) {
      case 'hello': {
        const proof = await ownershipProof(privateOf(state.device.keys.dh), m.relayKey, m.nonce);
        return wsSend({ type: 'register', handle: me.handle, deviceId: me.deviceId, list: state.list, proof });
      }
      case 'registered':
        registered = true;
        deliveryKey = m.deliveryKey;
        log(`[scalvs] online as +${me.handle.slice(1)}`);
        for (const w of readyWaiters.splice(0)) w();
        return;
      case 'prekey_count': {
        const up = await sm.maintainPreKeys(m.hasSpk ? m.count : 0, { forceSpk: !m.hasSpk });
        if (up) wsSend({ type: 'upload_prekeys', ...up });
        return;
      }
      case 'delivery_key':
        deliveryKey = m.key;
        return;
      case 'deliver':
        work = work.then(() => onDeliver(m.envelope)).catch((e) => log(`[scalvs] ${e.message}`));
        return;
      case 'error':
        if (!registered) log(`[scalvs] relay refused sign-in: ${m.error}`);
        return;
      default:
    }
  }

  function connect(url, wsOptions) {
    if (stopped) return;
    ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`, wsOptions);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      onRelay(m).catch((e) => log(`[scalvs] ${e.message}`));
    });
    ws.on('error', () => {}); // 'close' follows and reconnects
    ws.on('close', (code) => {
      registered = false;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('offline')); }
      pending.clear();
      if (!stopped && code !== 4001) setTimeout(() => connect(url, wsOptions), reconnectMs).unref();
    });
  }

  return {
    handle: me.handle,
    deviceId: me.deviceId,
    accountKey: state.account.publicJwk,
    /** Sign in to the relay at this http(s) URL; resolves once registered. */
    start(url, wsOptions = {}) {
      ai?.warm?.()?.catch(() => {}); // fetch and load an open model before the first AI task, not during it
      connect(url, wsOptions);
      return new Promise((r) => readyWaiters.push(r));
    },
    /** Wait for the envelopes received so far to be handled (tests). */
    idle: () => work,
    stop() {
      stopped = true;
      clearInterval(reminderTimer);
      ws?.close();
    },
  };
}

/** Is this the account key Scalvs signs in with? (the relay reserves the handle for it) */
export const isScalvsAccount = (bot, accountJwk) => Boolean(bot && accountJwk && keyId(bot.accountKey) === keyId(accountJwk));
