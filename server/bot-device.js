// A headless FabriC++ device for a bot: its own account key, device keys, signed device list and
// prekeys; it signs in over the relay's WebSocket like the browser client and talks Double Ratchet
// (with sealed sender) to each device of each person who writes to it. The relay still only stores
// and forwards ciphertext for it.
//
// This is the general form of what Scalvs (server/scalvs.js) does for +scalvs.veil; the Bot API
// (server/bots.js) runs one of these per registered bot. Whoever holds a bot's state (keys and
// ratchets) can read what people send that bot, so the state lives in the relay's secret data
// folder, and the client tells people that a bot's operator can read their messages to it.

import WebSocket from 'ws';
import { generateUserIdentity, generateSigningKey, ownershipProof, privateOf, newMessageId } from '../shared/crypto.js';
import { signDeviceList, verifyDeviceList, newDeviceId, deviceAddr, findDevice } from '../shared/devices.js';
import { SessionManager, emptyStore } from '../shared/session.js';
import { peekSealed, openSealed, isDeliveryKey } from '../shared/sealed.js';

const SEEN_KEEP = 2000;
const LIST_TTL_MS = 10 * 60_000; // re-check a contact's device list this often

/** Fresh keys for a bot account (account key + one device), as a plain object to persist. */
export async function newBotState(handle, name) {
  const account = await generateSigningKey();
  const device = { id: newDeviceId(), keys: await generateUserIdentity() };
  const list = await signDeviceList(account.privateJwk, {
    handle, version: 1, account: account.publicJwk,
    devices: [{ id: device.id, name: String(name || 'Bot').slice(0, 40), dh: device.keys.dh.publicJwk, sig: device.keys.sig.publicJwk, addedAt: Date.now() }],
  });
  return { v: 1, handle, account, device, list, sessions: emptyStore(), contacts: {}, seen: [], groups: {} };
}

/**
 * Run a bot device.
 * @param {object} o
 * @param {object} o.state      from newBotState (changed in place; call save after changes)
 * @param {Function} o.save     persist state (ratchet state must be on disk before ciphertext leaves)
 * @param {Function} o.onMessage  ({ from, fromDevice, id, ts, payload }) for every decrypted payload
 */
export function createBotDevice({ state, save, onMessage, log = console.log, now = Date.now, reconnectMs = 1000, tag = 'bot' }) {
  state.groups ??= {};
  const me = { handle: state.handle, deviceId: state.device.id, addr: deviceAddr(state.handle, state.device.id) };
  let ws = null;
  let stopped = false;
  let registered = false;
  let deliveryKey = null;
  let refSeq = 0;
  const pending = new Map(); // ref -> { type, resolve, reject, timer }
  let work = Promise.resolve(); // envelopes are handled one at a time, in order
  const readyWaiters = [];
  let keysUp = false; // the relay holds this device's signed prekey: others can start a session
  // ready = signed in AND reachable; before the prekeys are up, a first message to the bot fails
  const flushReady = () => { if (registered && keysUp) for (const w of readyWaiters.splice(0)) w(); };

  const sm = new SessionManager({
    handle: me.handle, deviceId: me.deviceId, identity: state.device.keys, store: state.sessions,
    fetchBundle: async (addr) => (await request({ type: 'bundle', addr }, 'bundle')).bundle,
    onChange: save,
  });

  const wsSend = (obj) => { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); };

  function request(obj, type, timeoutMs = 10_000) {
    const ref = `b${++refSeq}`;
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
    return openSealed(peeked, { myDh, senderDh: dev.dh });
  }

  async function open(raw) {
    const env = raw.sealed ? await unseal(raw) : raw;
    if (env.from === me.handle) return null; // one device; nothing to sync
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
    return { from: env.from, fromDevice: env.fromDevice, id: env.id, ts: env.ts, payload };
  }

  async function onDeliver(raw) {
    let msg = null;
    try { msg = await open(raw); } catch (e) { log(`[${tag}] dropped an envelope: ${e.message}`); }
    wsSend({ type: 'got', id: raw.id }); // saved (or unreadable): the relay may delete it
    // not awaited: onMessage may call send(), which queues behind this envelope
    if (msg) Promise.resolve().then(() => onMessage(msg)).catch((e) => log(`[${tag}] ${e.message}`));
  }

  // ---------- sending ----------
  /** Encrypt one payload to every device of these handles; returns the message id. */
  async function sendToMany(handles, payload, { id = newMessageId() } = {}) {
    const ts = now();
    const out = [];
    for (const h of handles) {
      if (h === me.handle) continue;
      let list;
      try { list = await listOf(h); } catch (e) { log(`[${tag}] no device list: ${e.message}`); continue; }
      for (const d of list.devices) {
        try { out.push(await sm.encrypt(deviceAddr(h, d.id), payload, { id, ts })); } catch (e) { log(`[${tag}] could not reach a device: ${e.message}`); }
      }
    }
    for (const envelope of out) wsSend({ type: 'send', envelope }); // ratchets saved by onChange first
    if (!out.length) throw new Error('no device of that chat could be reached');
    return { id, ts };
  }

  const withDk = (payload) => (deliveryKey && payload.kind === 'text' ? { ...payload, dk: deliveryKey } : payload);

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
        flushReady();
        return;
      case 'prekey_count': {
        const up = await sm.maintainPreKeys(m.hasSpk ? m.count : 0, { forceSpk: !m.hasSpk });
        if (up) wsSend({ type: 'upload_prekeys', ...up }); // the relay answers with another prekey_count
        else if (m.hasSpk) { keysUp = true; flushReady(); }
        return;
      }
      case 'delivery_key':
        deliveryKey = m.key;
        return;
      case 'deliver':
        work = work.then(() => onDeliver(m.envelope)).catch((e) => log(`[${tag}] ${e.message}`));
        return;
      case 'error':
        if (!registered) log(`[${tag}] relay refused sign-in for +${me.handle.slice(1)}: ${m.error}`);
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
      onRelay(m).catch((e) => log(`[${tag}] ${e.message}`));
    });
    ws.on('error', () => {});
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
    get online() { return registered; },
    start(url, wsOptions = {}) {
      connect(url, wsOptions);
      return new Promise((r) => readyWaiters.push(r));
    },
    /** Send a payload to a person (handle) or a group the bot is in ('#id'). */
    async send(chat, payload, opts) {
      // queue behind incoming envelopes so a reply never overtakes the message it answers
      const run = async () => {
        if (typeof chat === 'string' && chat.startsWith('#')) {
          const g = state.groups[chat.slice(1)];
          if (!g || !g.members.includes(me.handle)) throw new Error('the bot is not in that group');
          const body = payload.kind === 'text' ? { ...payload, group: { id: g.id, name: g.name, members: g.members } } : { ...payload, gid: g.id };
          return sendToMany(g.members, withDk(body), opts);
        }
        return sendToMany([chat], withDk(payload), opts);
      };
      const p = work.then(run);
      work = p.catch(() => {});
      return p;
    },
    /** Remember a group's members as last seen in a message (the bot replies to the same list). */
    noteGroup(g) {
      if (!g) return;
      state.groups[g.id] = { id: g.id, name: g.name, members: g.members };
      save();
    },
    forgetGroup(id) { delete state.groups[id]; save(); },
    idle: () => work,
    stop() {
      stopped = true;
      ws?.close();
    },
  };
}
