import {
  generateUserIdentity, generateSigningKey, generateIdentity, safetyNumber, ownershipProof,
  normalizeHandle, isValidHandle, privateOf, newMessageId, keyId, publicOnly, isPublicJwk,
} from '/shared/crypto.js';
import { SessionManager, emptyStore } from '/shared/session.js';
import {
  signDeviceList, verifyDeviceList, findDevice, nextDeviceList, newDeviceId, deviceAddr,
  encodeLinkCode, decodeLinkCode, MAX_DEVICES, DEVICE_ID_RE,
  linkConfirmCode, newLinkNonce, LINK_NONCE_RE,
} from '/shared/devices.js';
import { qrMatrix } from '/shared/qr.js';
import { linkChannelKey, sealJson, openJson, newRecoveryKey, parseRecoveryKey, sealBackup, openBackup } from '/shared/channel.js';
import { Vault, MIN_PASSPHRASE } from '/shared/vault.js';
import { idbBackend } from '/idb.js';
import { PURPOSES } from '/shared/economy.js';
import { createAi, installFakeModels, hideBuiltInModels } from '/ai.js';
import { languageName } from '/shared/ai.js';
import { TRANSLATION_LANGS } from '/shared/models.js';
import { createCalls } from '/calls.js';
import { createPhone } from '/phone.js';
import { seal, peekSealed, openSealed, isDeliveryKey } from '/shared/sealed.js';
import { applyAction, actionPayload, quoteOf, extrasOf, reactionSummary, QUICK_REACTIONS } from '/shared/actions.js';

// ---------- local vault (keys + history stay on this device, encrypted) ----------
// ?profile=name lets several devices/accounts run side by side in one browser for testing.
const PROFILE = new URLSearchParams(location.search).get('profile') || 'default';
const LEGACY_KEY = `fabric:v2:${PROFILE}`; // v0.2 kept everything in plain localStorage; migrated once
const vault = new Vault(idbBackend(`fabric-${PROFILE}`));

const LINK_DEVICE = 'FABRIC/v3/link/device';
const LINK_DONE = 'FABRIC/v3/link/done';
const HISTORY_SNAPSHOT = 200; // messages per conversation copied to a newly linked device
const REFRESH_MS = 15_000;

const fresh = () => ({
  handle: null, deviceId: null, deviceName: null, primary: false, self: null,
  contacts: {}, threads: {}, unread: {}, held: {}, crypto: emptyStore(), seen: [],
});
// on-device AI (public/ai.js): ?media=test&ai=fake swaps in a stand-in model for testing, and
// ?media=test&ai=open hides the browser's built-in model so the open models run instead
const QS_AI = new URLSearchParams(location.search);
if (QS_AI.get('media') === 'test' && QS_AI.get('ai') === 'fake') installFakeModels();
if (QS_AI.get('media') === 'test' && QS_AI.get('ai') === 'open') hideBuiltInModels();
const ai = createAi();
const aiPrefs = () => { db.ai ??= { replies: true, translateAll: false, translate: {} }; db.ai.out ??= {}; return db.ai; };
const LANG_RE = /^[a-z]{2,3}$/;
const translating = (peer) => Boolean(aiPrefs().translateAll || aiPrefs().translate[peer]);
const SEEN_MAX = 3000; // envelope keys already processed; the relay redelivers until we ack
const seenKey = (env) => `${env.from}#${env.fromDevice}:${env.id}`;
function markSeen(env) {
  (db.seen ??= []).push(seenKey(env));
  if (db.seen.length > SEEN_MAX) db.seen.splice(0, db.seen.length - SEEN_MAX);
}
let db = fresh();
// Long-term keys: { dh, sig, account? } with non-extractable private CryptoKeys, only in memory.
// `account` exists only on the primary device.
let identity = null;

/** Encrypt and store the current state. Await it before anything leaves the device. */
function persist() {
  const p = vault.unlocked ? vault.save(db) : Promise.resolve();
  p.catch((e) => console.error('could not save', e));
  return p;
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const myAccountKey = () => db.self.list.payload.account;
const myDevices = () => db.self?.list?.payload.devices || [];

function defaultDeviceName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  const name = os ? `${b} on ${os}` : b;
  return PROFILE === 'default' ? name : `${name} (${PROFILE})`;
}

// ---------- relay connection ----------
let ws = null;
let hello = null;
let registered = false;
let account = null;
let cidCfg = { enabled: false, required: false }; // from /api/cid
let cidState = null; // cid_status from the relay, once registered
let active = null; // handle of open thread
const pending = new Map(); // ref -> {resolve, reject}
let sessions = null; // SessionManager: X3DH + Double Ratchet state per contact device
let calls = null; // voice & video calls, signaled over the same sessions
let phone = null; // FABRIC Phone: ordinary phone numbers through the relay's carrier
let refSeq = 0;
let retry = 500;

function initSessions() {
  sessions = new SessionManager({
    handle: db.handle,
    deviceId: db.deviceId,
    identity,
    store: db.crypto,
    fetchBundle: async (addr) => {
      // anonymously when we hold that account's delivery key
      const h = addr.slice(0, addr.lastIndexOf('#'));
      const key = h === db.handle ? db.deliveryKey : db.contacts[h]?.dk;
      if (isDeliveryKey(key)) {
        try { return (await anonRequest({ type: 'bundle', addr, key })).bundle; } catch (e) { if (e.message !== 'not allowed' && e.message !== 'offline') throw e; }
      }
      return (await request({ type: 'bundle', addr })).bundle;
    },
    onChange: persist,
  });
  calls ??= createCalls({
    me: () => db.handle,
    myDevice: () => db.deviceId,
    contacts: () => Object.keys(db.contacts).filter((h) => db.contacts[h].list && !db.contacts[h].pendingAccount),
    devicesOf: async (peer) => {
      const c = await refreshContact(peer);
      if (c.pendingAccount) throw new Error(`${peer}'s account key changed — confirm it first`);
      return c.list.payload.devices;
    },
    send: sendSignal,
    log: (peer, text) => {
      systemLine(peer, text);
      persist(); renderContacts();
      if (peer === active) renderMessages();
    },
    feature: () => wsSend({ type: 'feature', feature: 'call' }),
    relay: { request, post: wsSend },
  });
}

/** Encrypt a control payload (calls) for one device and send it. Not stored in the thread. */
async function sendSignal(addr, payload) {
  if (!registered) throw new Error('offline');
  const toContact = addr.slice(0, addr.lastIndexOf('#')) !== db.handle;
  const env = await sessions.encrypt(addr, toContact && db.deliveryKey ? { ...payload, dk: db.deliveryKey } : payload);
  await persist(); // ratchet state first, as for messages
  deliver(env, { retries: 1 });
}

// ---------- sealed sender ----------
// Envelopes go over a second socket that never registers, sealed so only the recipient device
// learns who sent them (shared/sealed.js). The relay lets them through with the recipient
// account's delivery key, which contacts learn inside our messages. Lookups and prekey fetches
// go over the same socket, so the relay doesn't see whom we are about to write to either.
// Without the recipient's key (someone who never wrote to us), envelopes go named, as before.
const ANON_ROTATE_MS = 10 * 60_000; // a fresh socket now and then, so sends can't all be linked
let anon = null; // { ws, ready, born, pending }

function anonSocket() {
  if (anon && anon.ws.readyState <= 1) {
    if (Date.now() - anon.born < ANON_ROTATE_MS || anon.pending.size) return anon;
    anon.ws.close();
  }
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  const a = { ws, born: Date.now(), pending: new Map() };
  a.ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('offline')); });
  a.ready.catch(() => {});
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = m.ref && a.pending.get(m.ref);
    if (!p) return;
    a.pending.delete(m.ref);
    if (m.type === 'error') p.reject(Object.assign(new Error(m.error), { relay: true }));
    else p.resolve(m);
  };
  ws.onclose = () => {
    for (const p of a.pending.values()) p.reject(new Error('offline'));
    a.pending.clear();
    if (anon === a) anon = null;
  };
  return (anon = a);
}

async function anonRequest(obj) {
  const a = anonSocket();
  await a.ready;
  const ref = 'a' + ++refSeq;
  return new Promise((resolve, reject) => {
    a.pending.set(ref, { resolve, reject });
    a.ws.send(JSON.stringify({ ...obj, ref }));
    setTimeout(() => { if (a.pending.delete(ref)) reject(new Error('timed out')); }, 10_000);
  });
}

/** Their delivery key and the target device's DH key, or null when we must send named. */
function sealTarget(env) {
  const own = env.to === db.handle;
  const key = own ? db.deliveryKey : db.contacts[env.to]?.dk;
  const list = own ? db.self?.list : db.contacts[env.to]?.list;
  const dev = isDeliveryKey(key) && list && findDevice(list.payload, env.toDevice);
  return dev ? { key, dh: dev.dh } : null;
}

/**
 * Send one envelope copy. Sealed when possible; a connection problem is retried, then the copy
 * goes named (messages stay in the outbox and are resent sealed on reconnect instead).
 */
async function deliver(env, { retries = 3 } = {}) {
  const target = sealTarget(env);
  if (!target) return wsSend({ type: 'send', envelope: env });
  env.sealedId ??= newMessageId(); // the same outer id on every retry, so the relay dedupes it
  try {
    const sealed = await seal({ envelope: env, recipientDh: target.dh, senderDh: privateOf(identity.dh) });
    const r = await anonRequest({ type: 'sealed_send', to: env.to, toDevice: env.toDevice, key: target.key, id: env.sealedId, sealed });
    if (env.count) countLater();
    settleCopy(env, r.queued ? 'queued' : 'delivered', null, true);
  } catch (e) {
    if (e.message === 'not allowed') {
      // their delivery key changed: named until a message from them brings the new one
      if (env.to === db.handle) db.deliveryKey = null;
      else if (db.contacts[env.to]) db.contacts[env.to].dk = null;
      persist();
      return wsSend({ type: 'send', envelope: env });
    }
    if (e.relay && e.message !== 'rate limited') return settleCopy(env, 'failed', e.message);
    if (retries > 0) return setTimeout(() => deliver(env, { retries: retries - 1 }), 2000);
    if (!findMessage(env.id) && !(db.actionsOut || []).some((e) => e.id === env.id)) wsSend({ type: 'send', envelope: env }); // a call signal can't wait
  }
}

// Revenue share counts messages, but a sealed send doesn't say whose it is. With Usage opted in,
// the count is reported later in one batch, at a random time, so it can't be matched to sends.
const TALLY_MIN_MS = 30 * 60_000;
function countLater() {
  if (!account?.consent?.usage) return;
  db.tally = (db.tally || 0) + 1;
  db.tallyAt ??= Date.now() + TALLY_MIN_MS + Math.random() * 2 * TALLY_MIN_MS;
}
setInterval(() => {
  if (!registered || !db.tally || Date.now() < (db.tallyAt || 0)) return;
  wsSend({ type: 'tally', n: db.tally });
  db.tally = 0;
  db.tallyAt = null;
  persist();
}, 60_000);

/** Open a sealed envelope: claimed sender, their listed device key, then the inner box. */
async function unseal(env) {
  const me = deviceAddr(db.handle, db.deviceId);
  const mine = findDevice(db.self.list.payload, db.deviceId);
  const myDh = privateOf(identity.dh);
  let peeked;
  try { peeked = await peekSealed({ sealed: env.sealed, me, myDh, myDhPub: mine.dh }); } catch { return null; }
  const c = db.contacts[peeked.from];
  const dev = (await deviceOf(peeked.from, peeked.fromDevice).catch(() => null))
    || (c?.pendingList && findDevice(c.pendingList.payload, peeked.fromDevice)); // held until the key change is accepted
  if (!dev) return null;
  try {
    return await openSealed(peeked, { myDh, senderDh: dev.dh });
  } catch {
    return null; // not made by the device it names: drop it without blaming anyone
  }
}

function setConn(text, ok) {
  const c = $('conn');
  c.textContent = text;
  c.className = 'conn ' + (ok ? 'ok' : 'bad');
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { retry = 500; };
  ws.onclose = (ev) => {
    registered = false;
    if (ev.code === 4001) return revokedHere();
    setConn(ev.code === 4000 ? 'signed in in another tab' : 'offline — reconnecting', false);
    if (ev.code !== 4000) setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function wsSend(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function request(obj) {
  const ref = 'r' + ++refSeq;
  return new Promise((resolve, reject) => {
    pending.set(ref, { resolve, reject });
    wsSend({ ...obj, ref });
    setTimeout(() => { if (pending.delete(ref)) reject(new Error('timed out')); }, 10_000);
  });
}

async function register() {
  if (!db.self || !identity) return; // still opening or upgrading the vault; opened() registers
  const proof = await ownershipProof(privateOf(identity.dh), hello.relayKey, hello.nonce);
  wsSend({ type: 'register', handle: db.handle, deviceId: db.deviceId, list: db.self.list, proof });
}

let onboardWait = null; // {resolve, reject} while a new device is being registered

async function handle(msg) {
  if (msg.ref && pending.has(msg.ref)) {
    const p = pending.get(msg.ref); pending.delete(msg.ref);
    return msg.type === 'error' ? p.reject(new Error(msg.error)) : p.resolve(msg);
  }
  switch (msg.type) {
    case 'hello':
      hello = msg;
      if (identity) register();
      return;
    case 'registered':
      registered = true;
      if (isDeliveryKey(msg.deliveryKey)) db.deliveryKey = msg.deliveryKey;
      setConn('connected', true);
      phone ??= createPhone({ request, inCall: () => Boolean(calls?.active), vault: { get: () => (db.burners ??= { records: [], byPeer: {} }), save: () => persist() } });
      phone.refresh();
      await adoptOwnList(msg.list);
      if (onboardWait) { onboardWait.resolve(); onboardWait = null; }
      flushOutbox();
      calls?.reconnected();
      return;
    case 'sfu_offer':
    case 'sfu_members':
    case 'sfu_closed':
      return calls?.onRelay(msg);
    case 'devices':
      return adoptOwnList(msg.list);
    case 'delivery_key':
      if (isDeliveryKey(msg.key)) { db.deliveryKey = msg.key; persist(); }
      return;
    case 'phone_status':
      return phone?.onStatus(msg);
    case 'phone_event':
      return phone?.onEvent(msg.event);
    case 'account':
      account = msg;
      renderEarn();
      return;
    case 'cid_status':
      cidState = msg;
      if (!msg.linked && db.cid) { delete db.cid; persist(); }
      return renderCid();
    case 'prekey_count': {
      // keep the relay stocked with one-time prekeys and a current signed prekey
      const up = await sessions?.maintainPreKeys(msg.hasSpk ? msg.count : 0, { forceSpk: !msg.hasSpk });
      if (up) wsSend({ type: 'upload_prekeys', ...up });
      return;
    }
    case 'ack':
      return settleCopy(msg, msg.queued ? 'queued' : 'delivered');
    case 'deliver':
      return receive(msg.envelope);
    case 'mailbox':
      return onMailbox(msg.from, msg.payload);
    case 'error': {
      if (msg.ref && msg.toDevice) return settleCopy({ id: msg.ref, to: msg.to, toDevice: msg.toDevice }, 'failed', msg.error);
      if (onboardWait) {
        onboardWait.reject(new Error(msg.error === 'handle taken' ? 'That address is taken.' : msg.error));
        onboardWait = null;
        return;
      }
      if (msg.error === 'device not on the account') return revokedHere();
      if (msg.error === 'handle taken' || msg.error === 'proof failed') setConn('identity rejected by relay', false);
      console.warn('relay error', msg.error);
      return;
    }
  }
}

// ---------- my own device list ----------
async function adoptOwnList(list) {
  if (!list || !db.self) return;
  let payload;
  try {
    payload = await verifyDeviceList(list, { handle: db.handle, account: myAccountKey(), minVersion: db.self.list.payload.version });
  } catch (e) {
    console.warn('ignored own device list:', e.message);
    return;
  }
  if (!findDevice(payload, db.deviceId)) return revokedHere();
  db.self.list = list;
  persist();
  if (!$('view-security').classList.contains('hidden')) renderSecurity();
}

function revokedHere() {
  registered = false;
  setConn('removed from account', false);
  $('app').classList.add('hidden');
  $('revoked').classList.remove('hidden');
}

// ---------- outgoing copies (one per recipient device + my other devices) ----------
function findMessage(id) {
  for (const [peer, t] of Object.entries(db.threads)) {
    const m = t.find((x) => x.id === id);
    if (m) return { peer, m };
  }
  return null;
}

function settleCopy({ id, to, toDevice }, outcome, error, sealed = false) {
  if (settleAction({ id, to, toDevice })) return;
  const found = findMessage(id);
  if (!found?.m.out) return;
  const { m } = found;
  if (sealed && to !== db.handle) m.sealed = true;
  m.out = m.out.filter((e) => !(e.to === to && e.toDevice === toDevice));
  if (to !== db.handle) {
    if (outcome === 'queued') m.anyQueued = true;
    if (outcome === 'failed') { m.failedCopies = (m.failedCopies || 0) + 1; m.lastError = error; }
    else m.okCopies = (m.okCopies || 0) + 1;
  }
  if (!m.out.some((e) => e.to !== db.handle)) {
    if (m.okCopies) m.status = m.anyQueued ? 'queued' : 'delivered';
    else if (m.failedCopies) m.status = 'failed: ' + m.lastError;
  }
  if (!m.out.length) delete m.out;
  persist();
  renderMessages();
}

/** Resend anything the relay never acknowledged (sent while offline or cut off mid-send). */
function flushOutbox() {
  for (const t of Object.values(db.threads)) {
    for (const m of t) for (const env of m.out || []) deliver(env);
  }
  for (const env of db.actionsOut || []) deliver(env);
}

// ---------- contacts: accounts and their device lists ----------
async function lookupList(handle) {
  // anonymously: a lookup right before a sealed send would otherwise give the sender away
  try {
    return (await anonRequest({ type: 'lookup', handle })).list;
  } catch (e) {
    if (e.relay) throw e;
    return (await request({ type: 'lookup', handle })).list;
  }
}

function describeDeviceChanges(peer, before, after) {
  if (!before) return;
  const was = new Set(before.devices.map((d) => d.id));
  const now = new Set(after.devices.map((d) => d.id));
  for (const d of after.devices) if (!was.has(d.id)) systemLine(peer, `${peer} added a device: ${d.name}.`);
  for (const d of before.devices) if (!now.has(d.id)) systemLine(peer, `${peer} removed a device: ${d.name}.`);
}

/**
 * Fetch and verify a contact's device list. First contact pins their account key (trust on
 * first use; the safety number lets you check it). A different account key pauses the chat.
 */
async function refreshContact(handle, { force = false } = {}) {
  db.threads[handle] ??= [];
  let c = db.contacts[handle];
  if (c && !force && c.checkedAt && Date.now() - c.checkedAt < REFRESH_MS) return c;
  const list = await lookupList(handle);
  if (!c) {
    const payload = await verifyDeviceList(list, { handle });
    c = db.contacts[handle] = { account: payload.account, list, verified: false, addedAt: Date.now() };
  } else {
    try {
      const before = c.list?.payload;
      const payload = await verifyDeviceList(list, {
        handle, account: c.account ?? null, minVersion: before?.version ?? 0,
      });
      if (!c.account) c.account = payload.account; // re-pinning after the v0.4 upgrade
      describeDeviceChanges(handle, before, payload);
      c.list = list;
    } catch (e) {
      if (/account key changed/.test(e.message)) {
        c.pendingList = list; // relay presents a different account: stop and ask the user
        c.pendingAccount = list.payload.account;
      } else {
        console.warn(`kept cached device list for ${handle}:`, e.message);
      }
    }
  }
  c.checkedAt = Date.now();
  persist();
  return c;
}

function systemLine(peer, text) {
  (db.threads[peer] ??= []).push({ id: 'sys-' + Date.now() + Math.random(), from: '@system', text, ts: Date.now() });
}

async function addContact(raw) {
  const h = normalizeHandle(raw);
  if (!isValidHandle(h)) throw new Error('Use letters, numbers or _ (2–24), like @alex.veil');
  if (h === db.handle) throw new Error("That's you.");
  if (!db.contacts[h]?.list) await refreshContact(h, { force: true }).catch(() => { throw new Error(`${h} is not on FabriC++ yet.`); });
  openThread(h);
}

// ---------- messaging ----------
async function sendText(text, tr = null, extra = null, to = active) {
  if (extra === null && to === active && composeCtx?.mode === 'reply') { extra = { reply: composeCtx.quote }; clearComposeCtx(); }
  extra ||= {};
  const wire = { ...(extra.reply ? { reply: extra.reply } : {}), ...(extra.fwd ? { fwd: true } : {}) };
  try { await refreshContact(to); } catch { /* offline: use the cached device list */ }
  const c = db.contacts[to];
  if (!c?.list || c.pendingAccount) return;
  const id = newMessageId();
  const ts = Date.now();
  const out = [];
  const skipped = [];
  // every device of the contact, then my own other devices (so they show what I sent)
  const targets = [
    ...c.list.payload.devices.map((d) => ({ addr: deviceAddr(to, d.id), payload: { kind: 'text', text, ...trFields(tr), ...wire, dk: db.deliveryKey || undefined }, name: d.name })),
    ...myDevices().filter((d) => d.id !== db.deviceId)
      .map((d) => ({ addr: deviceAddr(db.handle, d.id), payload: { kind: 'sync', peer: to, text, ...trFields(tr), ...wire }, name: d.name })),
  ];
  for (const t of targets) {
    try {
      const env = await sessions.encrypt(t.addr, t.payload, { id, ts });
      if (env.to !== db.handle && !out.some((e) => e.to !== db.handle)) env.count = true; // count once
      out.push(env);
    } catch (err) {
      skipped.push(`${t.name}: ${err.message}`);
    }
  }
  const msg = { id, from: db.handle, text, ts, status: registered ? 'sending' : 'offline', out, ...(tr ? { sentTr: tr } : {}), ...extrasOf(wire) };
  if (!out.some((e) => e.to !== db.handle)) { msg.status = 'failed: ' + (skipped[0] || 'no devices'); delete msg.out; }
  (db.threads[to] ??= []).push(msg);
  if (to === active) { renderMessages(); renderPqBadge(); }
  renderContacts();
  // The ratchets have advanced: that must be on disk before any ciphertext leaves, or a crash
  // could make this device reuse a message key for a different message.
  try { await persist(); } catch {
    msg.status = 'failed: could not save'; delete msg.out; renderMessages();
    return;
  }
  for (const env of out) deliver(env);
}

/**
 * Edit, delete or react: applied here at once, then sent to every device of the contact and to my
 * own other devices. Copies wait in db.actionsOut until the relay takes them, like messages do.
 */
async function sendAction(to, act, target, fields = {}) {
  const c = db.contacts[to];
  if (!c?.list || c.pendingAccount) return;
  const payload = actionPayload(act, target, fields);
  if (!applyAction(db.threads[to] || [], db.handle, payload)) return;
  const id = newMessageId();
  const ts = Date.now();
  const targets = [
    ...c.list.payload.devices.map((d) => ({ addr: deviceAddr(to, d.id), payload })),
    ...myDevices().filter((d) => d.id !== db.deviceId).map((d) => ({ addr: deviceAddr(db.handle, d.id), payload: { ...payload, peer: to } })),
  ];
  const out = [];
  for (const t of targets) {
    try { out.push(await sessions.encrypt(t.addr, t.payload, { id, ts })); } catch { /* that device misses this one */ }
  }
  (db.actionsOut ??= []).push(...out);
  if (to === active) renderMessages();
  renderContacts();
  try { await persist(); } catch { return; }
  for (const env of out) deliver(env);
}

function settleAction({ id, to, toDevice }) {
  const i = (db.actionsOut || []).findIndex((e) => e.id === id && e.to === to && e.toDevice === toDevice);
  if (i < 0) return false;
  db.actionsOut.splice(i, 1);
  persist();
  return true;
}

/** Sent translated: the original and both languages go along (inside the encryption, like the text). */
const trFields = (tr) => (tr ? { orig: tr.text, ol: tr.from, tl: tr.to } : {});
function sentTrOf(payload) {
  const { orig, ol, tl } = payload;
  if (typeof orig !== 'string' || !orig.trim() || !LANG_RE.test(ol) || !LANG_RE.test(tl)) return null;
  return { text: orig.slice(0, 4000), from: ol, to: tl };
}

async function deviceOf(handle, deviceId) {
  const listOf = () => (handle === db.handle ? db.self.list : db.contacts[handle]?.list)?.payload;
  let dev = listOf() && findDevice(listOf(), deviceId);
  if (!dev && registered) {
    if (handle === db.handle) await adoptOwnList(await lookupList(handle));
    else await refreshContact(handle, { force: true });
    dev = listOf() && findDevice(listOf(), deviceId);
  }
  return dev;
}

/** Process one delivered envelope, save, then tell the relay it can delete it. */
async function receive(env) {
  try {
    const inner = env.sealed ? await unseal(env) : env;
    if (inner) await processEnvelope(inner);
  } catch (e) { console.warn('could not process envelope', e); }
  try { await persist(); } catch { return; } // not saved: let the relay redeliver it
  wsSend({ type: 'got', id: env.id });
}

async function processEnvelope(env) {
  if (db.seen?.includes(seenKey(env))) return; // redelivery of something already handled
  // also already handled: a message with this id from this sender is in a thread (e.g. stored by
  // a pre-0.6 client that never acked, or a seen key that aged out). Its key is spent; skip it.
  if (Object.values(db.threads).some((t) => t.some((m) => m.id === env.id && (m.from === env.from || env.from === db.handle)))) {
    markSeen(env);
    return;
  }
  const fromSelf = env.from === db.handle;
  if (!fromSelf && !db.contacts[env.from]) {
    try { await refreshContact(env.from, { force: true }); } catch { return; } // someone new
  }
  const c = fromSelf ? null : db.contacts[env.from];
  if (c?.pendingAccount) {
    (db.held[env.from] ??= []).push(env); persist(); renderContacts();
    if (env.from === active) renderKeyWarning();
    return;
  }
  const dev = await deviceOf(env.from, env.fromDevice).catch(() => null);
  if (!dev) return; // not a device on that account's signed list
  let payload;
  try {
    payload = await sessions.decrypt(env, { dh: dev.dh, sig: dev.sig });
  } catch {
    markSeen(env);
    if (!fromSelf) {
      systemLine(env.from, 'A message could not be decrypted and was discarded.');
      persist(); renderContacts(); if (env.from === active) renderMessages();
    }
    return;
  }
  markSeen(env);
  if (!fromSelf && c && isDeliveryKey(payload.dk) && c.dk !== payload.dk) c.dk = payload.dk; // they accept sealed sends from us
  if (payload.kind === 'call') {
    if (!fromSelf) calls?.onSignal(env, payload);
    return;
  }
  if (payload.kind === 'action') {
    const peer = fromSelf ? payload.peer : env.from;
    if (!isValidHandle(peer) || !db.threads[peer]) return;
    const m = applyAction(db.threads[peer], fromSelf ? db.handle : env.from, payload, env.ts);
    if (!m) return;
    persist();
    renderContacts();
    if (peer === active) renderMessages();
    if (payload.act === 'edit' && !fromSelf && translating(peer)) translateEntry(peer, m);
    return;
  }
  let peer;
  let entry;
  if (fromSelf) {
    // a message I sent from another of my devices
    if (payload.kind !== 'sync' || !isValidHandle(payload.peer)) return;
    peer = payload.peer;
    if (!db.contacts[peer]) await refreshContact(peer, { force: true }).catch(() => {});
    entry = { id: env.id, from: db.handle, text: String(payload.text ?? ''), ts: env.ts, status: 'sent from another device', ...extrasOf(payload) };
    const st = sentTrOf(payload);
    if (st) entry.sentTr = st;
  } else {
    if (payload.kind !== 'text') return;
    peer = env.from;
    entry = { id: env.id, from: peer, text: String(payload.text ?? ''), ts: env.ts, ...extrasOf(payload) };
    const st = sentTrOf(payload);
    if (st) entry.sentTr = st;
  }
  const thread = (db.threads[peer] ??= []);
  if (thread.some((m) => m.id === env.id)) return;
  thread.push(entry);
  thread.sort((a, b) => a.ts - b.ts);
  if (!fromSelf && (peer !== active || document.hidden)) db.unread[peer] = (db.unread[peer] || 0) + 1;
  persist();
  renderContacts();
  if (peer === active) renderMessages();
  if (!fromSelf && translating(peer)) translateEntry(peer, entry);
}

// ---------- rendering ----------
function renderContacts() {
  const ul = $('contacts');
  ul.replaceChildren();
  const q = searchQuery();
  const handles = Object.keys(db.contacts).sort((a, b) => lastTs(b) - lastTs(a))
    .filter((h) => !q || h.toLowerCase().includes(q));
  for (const h of handles) {
    const li = el('li', h === active ? 'active' : '');
    const left = el('div', 'contact-main');
    const top = el('div', 'contact-top');
    const name = el('div', 'contact-name', h);
    if (db.contacts[h].verified) name.append(' ', el('span', 'verified', '✓'));
    const last = db.threads[h]?.filter((m) => m.from !== '@system').at(-1);
    const lastAny = db.threads[h]?.at(-1);
    top.append(name, el('span', 'contact-time', lastAny ? shortWhen(lastAny.ts) : ''));
    const bottom = el('div', 'contact-bottom');
    const mine = last && last.from === db.handle;
    bottom.append(el('div', 'preview', last ? (mine ? 'You: ' : '') + last.text : 'No messages yet'));
    if (db.unread[h]) bottom.append(el('span', 'badge', String(db.unread[h])));
    left.append(top, bottom);
    li.append(avatarEl(h), left);
    li.onclick = () => openThread(h);
    ul.append(li);
  }
  if (!handles.length) {
    const hint = q
      ? (isValidHandle(normalizeHandle(q)) ? `No chats match. Press + to start a chat with ${normalizeHandle(q)}.` : 'No chats match.')
      : 'No chats yet. Type an address like @alex above and press +.';
    ul.append(el('li', 'contacts-empty', hint));
  }
  renderSearchHits(q);
}
const searchQuery = () => ($('add-handle')?.value || '').trim().toLowerCase().replace(/^@$/, '');

/** Messages matching the search box, across every chat on this device. */
function renderSearchHits(q) {
  const box = $('search-hits');
  box.replaceChildren();
  const hits = [];
  if (q.length >= 2) {
    for (const [h, list] of Object.entries(db.threads)) {
      for (const m of list) if (m.from !== '@system' && m.text?.toLowerCase().includes(q)) hits.push({ h, m });
    }
  }
  box.classList.toggle('hidden', !hits.length);
  if (!hits.length) return;
  hits.sort((a, b) => b.m.ts - a.m.ts);
  box.append(el('div', 'eyebrow', `Messages · ${hits.length}`));
  for (const { h, m } of hits.slice(0, 40)) {
    const b = el('button', 'hit');
    b.type = 'button';
    const top = el('div', 'contact-top');
    top.append(el('span', 'contact-name', h), el('span', 'contact-time', shortWhen(m.ts)));
    b.append(top, highlighted(m.text, q, 'preview'));
    b.onclick = () => { openThread(h).then(() => openThreadSearch(q)); };
    box.append(b);
  }
}

/** Text with every match of q wrapped in <mark>, built without innerHTML. */
function highlighted(text, q, cls) {
  const out = el('div', cls);
  const low = text.toLowerCase();
  let i = 0;
  for (let j = q ? low.indexOf(q) : -1; j >= 0; j = low.indexOf(q, i)) {
    out.append(document.createTextNode(text.slice(i, j)), el('mark', '', text.slice(j, j + q.length)));
    i = j + q.length;
  }
  out.append(document.createTextNode(text.slice(i)));
  return out;
}

function avatarEl(h, cls = 'avatar') {
  const a = el('div', cls, (h.replace(/^@/, '')[0] || '?').toUpperCase());
  a.setAttribute('aria-hidden', 'true');
  a.style.background = avatarColor(h);
  return a;
}
function avatarColor(h) {
  let x = 0;
  for (const ch of h) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 22% 34%)`;
}
function shortWhen(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
const lastTs = (h) => db.threads[h]?.at(-1)?.ts || db.contacts[h]?.addedAt || 0;

function renderMessages() {
  if (!active) return;
  const ol = $('messages');
  ol.replaceChildren();
  const q = threadQuery;
  let lastDay = '', hits = 0, lastHit = null;
  for (const m of db.threads[active] || []) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { ol.append(el('li', 'day-sep', dayLabel(m.ts))); lastDay = day; }
    if (m.from === '@system') { ol.append(el('li', 'sysline', m.text)); continue; }
    const mine = m.from === db.handle;
    const li = el('li', 'msg' + (mine ? ' mine' : '') + (m.status?.startsWith('failed') ? ' failed' : '') + (m.deleted ? ' deleted' : ''));
    li.dataset.id = m.id;
    li.tabIndex = 0;
    bindMessageMenu(li, m);
    const time0 = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (m.deleted) {
      li.append(el('div', 'msg-text', mine ? 'You deleted this message' : 'This message was deleted'));
      li.append(el('div', 'meta', time0));
      ol.append(li);
      continue;
    }
    if (m.forwarded) li.append(el('div', 'fwd-label', 'Forwarded'));
    if (m.reply) {
      const quote = el('button', 'quote');
      quote.type = 'button';
      const orig = (db.threads[active] || []).find((x) => x.id === m.reply.id);
      quote.append(el('span', 'quote-from', m.reply.from === db.handle ? 'You' : m.reply.from), el('span', 'quote-text', orig?.deleted || !m.reply.text ? 'Deleted message' : m.reply.text));
      quote.onclick = (e) => { e.stopPropagation(); jumpTo(m.reply.id); };
      li.append(quote);
    }
    const translated = !mine && m.tr?.text && !showOriginal.has(m.id);
    const flipped = m.sentTr && showOriginal.has(m.id); // a message sent translated, shown as written
    const shown = flipped ? m.sentTr.text : translated ? m.tr.text : m.text;
    if (q && shown.toLowerCase().includes(q)) { li.append(...highlighted(shown, q, 'msg-text').childNodes); li.classList.add('hit'); hits++; lastHit = li; }
    else li.append(document.createTextNode(shown));
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const ed = m.edited ? 'edited · ' : '';
    li.append(el('div', 'meta', mine ? `${ed}${time} · ${m.status || ''}${m.sealed ? ' · sealed' : ''}` : ed + time));
    if (m.sentTr) {
      const lang = languageName(m.sentTr.to);
      const label = mine
        ? (flipped ? `As you wrote it · sent in ${lang} · ` : `Sent in ${lang}, translated on your device · `)
        : (flipped ? `As they wrote it in ${languageName(m.sentTr.from)} · ` : `They wrote in ${languageName(m.sentTr.from)}, translated on their device · `);
      const note = el('div', 'tr-note', label);
      const b = el('button', 'link', flipped ? 'show what was sent' : 'show original');
      b.type = 'button';
      b.onclick = () => { if (showOriginal.has(m.id)) showOriginal.delete(m.id); else showOriginal.add(m.id); renderMessages(); };
      note.append(b);
      li.append(note);
    } else if (!mine && m.tr?.text) {
      const note = el('div', 'tr-note', translated ? `Translated on device from ${languageName(m.tr.from)} · ` : 'Original · ');
      const b = el('button', 'link', translated ? 'show original' : 'show translation');
      b.type = 'button';
      b.onclick = () => { if (showOriginal.has(m.id)) showOriginal.delete(m.id); else showOriginal.add(m.id); renderMessages(); };
      note.append(b);
      li.append(note);
    }
    const groups = reactionSummary(m, db.handle);
    if (groups.length) {
      const row = el('div', 'reactions');
      for (const g of groups) {
        const b = el('button', 'reaction' + (g.mine ? ' mine' : ''), g.count > 1 ? `${g.emoji} ${g.count}` : g.emoji);
        b.type = 'button';
        b.title = g.mine ? 'Remove your reaction' : `React with ${g.emoji}`;
        b.onclick = (e) => { e.stopPropagation(); react(m, g.mine ? '' : g.emoji); };
        row.append(b);
      }
      li.append(row);
    }
    ol.append(li);
  }
  if (q) {
    $('thread-search-count').textContent = hits ? `${hits} found` : 'None found';
    lastHit?.scrollIntoView({ block: 'center' });
  } else ol.scrollTop = ol.scrollHeight;
  renderTranslateToggle();
  renderTranslateOut();
  suggestReplies();
}

// ---------- on-device AI: translating what I send ----------
/** The "Send in" menu: as written, or translated into a language (their language first when known). */
function renderTranslateOut() {
  const sel = $('translate-out');
  if (!active) return;
  const theirs = (db.threads[active] || []).filter((m) => m.from === active).map((m) => m.tr?.from || m.sentTr?.from).filter(Boolean).at(-1);
  const langs = [...new Set([...(theirs && TRANSLATION_LANGS.includes(theirs) ? [theirs] : []), ...TRANSLATION_LANGS])].filter((l) => l !== ai.target || l === aiPrefs().out[active]);
  const want = aiPrefs().out[active] || '';
  const key = `${active}|${langs.join(',')}|${want}`;
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  sel.replaceChildren(new Option('As written', ''));
  for (const l of langs) sel.append(new Option(`In ${languageName(l)}${l === theirs ? ' (theirs)' : ''}`, l));
  sel.value = want;
}

function closeOutPreview() { $('out-preview').classList.add('hidden'); $('out-preview').replaceChildren(); }

/** Translate the draft, show it, and send only after a second tap. */
async function previewOut(peer, text, to, { allowDownload = false } = {}) {
  const box = $('out-preview');
  box.replaceChildren(el('span', 'muted small', `Translating into ${languageName(to)} on this device…`));
  box.classList.remove('hidden');
  let r;
  try {
    r = await ai.translateOut(text, to, { allowDownload, onProgress: (p) => { box.firstChild.textContent = `Downloading the translation model… ${Math.round(p * 100)}%`; } });
  } catch (e) {
    box.replaceChildren(el('span', 'error small', `Translation failed: ${e.message}`));
    return;
  }
  if (active !== peer) return;
  if (r === null) { // already in that language, or no model for it
    const same = (await ai.languageOf(text)) === to;
    if (same) { closeOutPreview(); $('text').value = ''; return sendText(text); }
    box.replaceChildren(el('span', 'small', `No on-device model can translate this into ${languageName(to)}. `));
    const b = el('button', 'ghost', 'Send as written');
    b.type = 'button';
    b.onclick = () => { closeOutPreview(); $('text').value = ''; sendText(text); };
    return box.append(b);
  }
  if (r.needsDownload) {
    box.replaceChildren(el('span', 'small', `Translating ${languageName(r.from)} into ${languageName(to)} needs a one-time download of the on-device model.`));
    const b = el('button', 'ghost', 'Download');
    b.type = 'button';
    b.onclick = () => previewOut(peer, text, to, { allowDownload: true });
    return box.append(b);
  }
  // they get the translation; what I wrote goes along so either of us can look at it
  const area = el('textarea', 'text-input');
  area.value = String(r.text).slice(0, 4000);
  area.rows = 2;
  area.setAttribute('aria-label', `Message in ${languageName(to)}`);
  const send = el('button', 'primary', `Send in ${languageName(to)}`);
  send.type = 'button';
  send.onclick = () => {
    const out = area.value.trim();
    if (!out) return;
    closeOutPreview();
    $('text').value = '';
    sendText(out, { text, from: r.from, to });
  };
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = closeOutPreview;
  box.replaceChildren(el('div', 'eyebrow', `Translated on this device from ${languageName(r.from)} · check it, then send`), area, el('div', 'row', ''));
  box.lastChild.append(send, cancel);
  area.focus();
}

// ---------- on-device AI: translation and suggested replies ----------
const showOriginal = new Set(); // message ids shown untranslated (this session only)
let aiNeeds = null; // { peer, from }: a translation model to download first
let replyState = { key: null, list: [] };

function renderTranslateToggle() {
  const b = $('translate-toggle');
  const on = active && translating(active);
  b.setAttribute('aria-pressed', String(Boolean(on)));
  b.textContent = on ? 'Translating' : 'Translate';
  b.title = aiPrefs().translateAll ? 'Every chat is translated (Security → On-device AI)' : 'Translate incoming messages on this device';
  const box = $('ai-needs');
  if (aiNeeds && aiNeeds.peer === active) {
    box.replaceChildren(el('span', '', `Translating ${languageName(aiNeeds.from)} needs a one-time download of the on-device translation model.`));
    const btn = el('button', 'ghost', 'Download');
    btn.type = 'button';
    btn.onclick = () => downloadTranslator(aiNeeds.peer, aiNeeds.from, btn);
    box.append(btn);
    box.classList.remove('hidden');
  } else box.classList.add('hidden');
}

/** Translate one incoming message. Saved with the message, in the encrypted vault. */
async function translateEntry(peer, m, { allowDownload = false, onProgress } = {}) {
  if (m.tr || m.sentTr || m.from === db.handle || !m.text?.trim()) return;
  try {
    const r = await ai.translate(m.text, { allowDownload, onProgress });
    if (!r) return;
    if (r.needsDownload) { aiNeeds = { peer, from: r.from }; if (peer === active) renderTranslateToggle(); return; }
    m.tr = { from: r.from, text: String(r.text).slice(0, 8000) };
    persist();
    if (peer === active) renderMessages();
  } catch (e) {
    console.warn('on-device translation failed', e);
  }
}

async function translateRecent(peer, opts) {
  for (const m of (db.threads[peer] || []).filter((x) => x.from !== db.handle && x.from !== '@system').slice(-30)) {
    if (!translating(peer)) return;
    await translateEntry(peer, m, opts);
  }
}

async function downloadTranslator(peer, from, btn) {
  btn.disabled = true;
  const progress = (p) => { btn.textContent = `Downloading… ${Math.round(p * 100)}%`; };
  aiNeeds = null;
  await translateRecent(peer, { allowDownload: true, onProgress: progress });
  renderTranslateToggle();
}

$('translate-toggle').onclick = () => {
  if (!active) return;
  const p = aiPrefs();
  if (p.translateAll) return; // controlled in Security → On-device AI
  p.translate[active] = !p.translate[active];
  if (!p.translate[active]) delete p.translate[active];
  persist();
  renderMessages();
  if (translating(active)) {
    translateRecent(active);
    wsSend({ type: 'feature', feature: 'translate' }); // counted only if Product research is opted in
  }
};

/** Up to three replies under the composer when the last message is theirs. Never sent by themselves. */
function suggestReplies() {
  const box = $('replies');
  const msgs = (db.threads[active] || []).filter((m) => m.from !== '@system' && m.text);
  const last = msgs.at(-1);
  if (!aiPrefs().replies || !last || last.from === db.handle || db.contacts[active]?.pendingAccount) {
    box.classList.add('hidden');
    return;
  }
  const key = `${active}|${last.id}`;
  if (replyState.key === key) return drawReplies(replyState.list);
  replyState = { key, list: [] };
  box.classList.add('hidden');
  const peer = active;
  ai.replies(msgs.map((m) => (m.tr?.text && m.from !== db.handle ? { ...m, text: m.tr.text } : m)), db.handle).then((list) => {
    if (replyState.key !== key) return;
    replyState.list = list;
    if (active === peer) drawReplies(list);
  }).catch((e) => console.warn('suggested replies failed', e));
}

function drawReplies(list) {
  const box = $('replies');
  if (!list.length) return box.classList.add('hidden');
  box.replaceChildren(el('div', 'eyebrow', 'Suggested on this device'));
  for (const r of list) {
    const b = el('button', 'reply-chip', r);
    b.type = 'button';
    b.onclick = () => {
      $('text').value = r; // filled in, not sent: the user reads it and presses Send
      $('text').focus();
      wsSend({ type: 'feature', feature: 'reply' });
    };
    box.append(b);
  }
  box.classList.remove('hidden');
}

const AI_STATE_TEXT = {
  available: 'Ready on this device',
  downloadable: 'Needs a one-time download (Download models)',
  downloading: 'Downloading…',
  unavailable: 'Not available in this browser',
};

async function renderAiStatus() {
  const st = await ai.status();
  const how = (x, size) => {
    const by = x.engine === 'built-in' ? "the browser's built-in model" : 'an open model run here';
    if (x.state === 'downloadable') return `Needs a one-time download of ${by}${size ? ` (about ${size} MB)` : ''} · Download models`;
    if (x.state === 'unavailable') return null;
    return `${AI_STATE_TEXT[x.state] || x.state} · ${by}`;
  };
  const rows = [
    ['Summaries', how(st.summarizer, st.sizes.assistant) ?? 'No model here: a simple summary computed on this device instead'],
    ['Language detection', how(st.detector) ?? AI_STATE_TEXT.unavailable],
    [`Translation`, st.translator.state === 'unavailable' ? AI_STATE_TEXT.unavailable
      : `Both ways, per language, downloaded the first time a chat needs it${st.translator.engine === 'open' ? ` (about ${st.sizes.translation} MB each way, open model)` : " (the browser's built-in model)"}`],
    ['Suggested replies', how(st.replies, st.sizes.assistant) ?? AI_STATE_TEXT.unavailable],
  ];
  const tb = $('ai-status');
  tb.replaceChildren();
  for (const [k, v] of rows) { const tr = el('tr'); tr.append(el('th', '', k), el('td', '', v)); tb.append(tr); }
  $('ai-replies').checked = aiPrefs().replies;
  $('ai-translate-all').checked = aiPrefs().translateAll;
  $('ai-download').classList.toggle('hidden', ![st.summarizer, st.detector, st.replies].some((x) => x.state === 'downloadable' || x.state === 'downloading'));
}

$('ai-replies').onchange = (e) => { aiPrefs().replies = e.target.checked; replyState = { key: null, list: [] }; persist(); };
$('ai-translate-all').onchange = (e) => { aiPrefs().translateAll = e.target.checked; persist(); };
$('ai-download').onclick = async () => {
  const btn = $('ai-download');
  const msg = $('ai-msg');
  btn.disabled = true;
  msg.className = 'small';
  try {
    const done = await ai.download((what, p) => { msg.textContent = `Downloading ${what}… ${Math.round(p * 100)}%`; });
    msg.textContent = done.length ? `Ready: ${done.join(', ')}.` : 'Nothing to download in this browser.';
  } catch (e) {
    msg.className = 'error small'; msg.textContent = e.message;
  } finally {
    btn.disabled = false;
    renderAiStatus();
  }
};

function renderKeyWarning() {
  const c = db.contacts[active];
  const box = $('key-warning');
  $('call-buttons').classList.toggle('hidden', Boolean(c?.pendingAccount));
  if (!c?.pendingAccount) { box.classList.add('hidden'); $('composer').classList.remove('hidden'); return; }
  box.replaceChildren(
    el('div', '', `${active}'s account key changed. This can mean they started over on a new device without a backup — or that someone is intercepting. Messages are paused until you confirm their new safety number with them.`),
  );
  const btn = el('button', 'ghost', 'Accept new key');
  btn.onclick = async () => {
    const peer = active;
    c.account = c.pendingAccount; c.list = c.pendingList; c.verified = false;
    delete c.pendingAccount; delete c.pendingList;
    await sessions.reset(peer); // old sessions were bound to the old devices
    systemLine(peer, 'Account key changed and accepted. New sessions will be set up.');
    const held = db.held[peer] || [];
    delete db.held[peer];
    persist(); renderKeyWarning(); renderContacts(); renderMessages();
    for (const env of held) await receive(env);
  };
  box.append(btn);
  box.classList.remove('hidden');
  $('composer').classList.add('hidden');
}

/** "post-quantum" in the chat header when every device session with this contact is v3. */
function renderPqBadge() {
  const badge = $('pq-badge');
  const devices = active ? db.contacts[active]?.list?.payload?.devices || [] : [];
  const kinds = devices.map((d) => sessions?.sessionKind(deviceAddr(active, d.id))).filter(Boolean);
  badge.textContent = !kinds.length ? '' : kinds.every((k) => k === 'pq') ? ' · post-quantum' : ' · classic keys (post-quantum once both apps are up to date)';
  badge.title = kinds.length && kinds.every((k) => k === 'pq')
    ? 'Session keys combine P-256 and ML-KEM-768, so recorded messages stay safe even against a future quantum computer.'
    : '';
}

async function openThread(h) {
  closeOutPreview(); // a translation preview belongs to the chat it was made in
  active = h;
  delete db.unread[h];
  persist();
  $('empty').classList.add('hidden');
  $('thread').classList.remove('hidden');
  $('peer').textContent = h;
  $('peer-avatar').replaceWith(Object.assign(avatarEl(h), { id: 'peer-avatar' }));
  $('safety').classList.add('hidden');
  $('summary').classList.add('hidden');
  closeThreadMenu();
  closeThreadSearch();
  closeMsgMenu();
  if (composeCtx) clearComposeCtx();
  switchTab('chats');
  renderContacts(); renderMessages(); renderKeyWarning(); renderPqBadge();
  if (registered) {
    try { await refreshContact(h, { force: true }); } catch { /* offline or unknown: keep cached list */ }
    if (active === h) { renderKeyWarning(); renderMessages(); }
  }
  // On touch screens focusing would pop up the keyboard over the conversation; let the user tap.
  if (!matchMedia('(pointer: coarse)').matches) $('text').focus();
}

async function showSafety() {
  const box = $('safety');
  if (!box.classList.contains('hidden')) return box.classList.add('hidden');
  const c = db.contacts[active];
  const theirs = c.pendingAccount || c.account;
  if (!theirs) return;
  const digits = await safetyNumber(db.handle, myAccountKey(), active, theirs);
  box.replaceChildren(
    el('div', 'muted small', `Compare with ${active} in person or on a call. If the numbers match, nobody is in the middle. Adding or removing devices does not change it.`),
    el('div', 'digits', digits),
  );
  const devices = (c.pendingList || c.list)?.payload.devices || [];
  box.append(el('div', 'muted small', `Their devices: ${devices.map((d) => d.name).join(', ')}`));
  const btn = el('button', 'ghost', c.verified ? 'Verified ✓ (click to unmark)' : 'Mark as verified');
  btn.onclick = () => { c.verified = !c.verified; persist(); renderContacts(); box.classList.add('hidden'); showSafety(); };
  box.append(btn);
  box.classList.remove('hidden');
}

async function showSummary() {
  const box = $('summary');
  if (!box.classList.contains('hidden')) return box.classList.add('hidden');
  const peer = active;
  const msgs = (db.threads[peer] || []).filter((m) => m.from !== '@system')
    .map((m) => (m.tr?.text && m.from !== db.handle ? { ...m, text: m.tr.text } : m));
  box.replaceChildren(el('div', 'eyebrow', 'Summarizing on this device…'));
  box.classList.remove('hidden');
  const s = await ai.summarize(msgs, db.handle);
  if (active !== peer || box.classList.contains('hidden')) return;
  box.replaceChildren(el('div', 'eyebrow', s.engine === 'model'
    ? 'Summary · on-device model, nothing sent'
    : 'Summary · simple local summary (no model in this browser), nothing sent'));
  const ul = el('ul');
  for (const line of s.lines) ul.append(el('li', '', line));
  box.append(ul);
  wsSend({ type: 'feature', feature: 'summary' }); // counted only if Product research is opted in
}

// ---------- earn ----------
function renderEarn() {
  if (!account) return;
  const wrap = $('purposes');
  wrap.replaceChildren();
  for (const [key, p] of Object.entries(PURPOSES)) {
    const row = el('label', 'purpose');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(account.consent[key]);
    cb.onchange = () => wsSend({ type: 'consent', consent: { ...account.consent, [key]: cb.checked } });
    const text = el('div');
    text.append(el('b', '', p.label), el('span', 'muted small', p.detail));
    row.append(cb, text);
    wrap.append(row);
  }
  $('balance').textContent = account.balanceFab.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const c = account.counters;
  $('counters').textContent = `Counted while opted in — messages: ${c.usage || 0} · delivery samples: ${c.network || 0} · feature uses: ${c.research || 0}`;

  const payouts = $('payouts');
  payouts.replaceChildren();
  if (!account.payouts.length) payouts.append(el('li', 'muted', 'No payouts yet.'));
  for (const p of account.payouts.slice().reverse()) {
    payouts.append(el('li', '', `${new Date(p.at).toLocaleString()} · $${(p.cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} → ${p.fab.toLocaleString(undefined, { maximumFractionDigits: 2 })} $FAB · #${p.seq}`));
  }
  const receipts = $('receipts');
  receipts.replaceChildren();
  if (!account.receipts.length) receipts.append(el('li', 'muted', 'No consent changes yet. Everything is off by default.'));
  for (const r of account.receipts.slice().reverse()) {
    const on = Object.entries(r.consent).filter(([, v]) => v).map(([k]) => PURPOSES[k].label);
    receipts.append(el('li', '', `#${r.seq} ${new Date(r.at).toLocaleString()} — ${on.length ? on.join(', ') : 'all off'} — ${r.hash.slice(0, 16)}…`));
  }
}

async function preview() {
  const revenue = Number($('revenue').value || 0);
  // over our own authenticated socket: the public endpoint only gives totals, not who gets what
  const r = await request({ type: 'preview', revenue }).catch(() => null);
  if (!r) return;
  const usd = (cents) => `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const mine = r.mineCents || 0;
  const rows = [
    ['Eligible net revenue', usd(r.revenueCents)],
    ['User reward pool (70%)', usd(r.poolCents)],
    ['Infinitum share', usd(r.infinitumCents)],
    ['Participating users', String(r.participants)],
    ['Your allocation', `${usd(mine)} → ${((mine / 100) * r.fabPerUsd).toFixed(2)} $FAB`, 'you'],
  ];
  const tb = $('split');
  tb.replaceChildren();
  for (const [k, v, cls] of rows) {
    const tr = el('tr', cls || '');
    tr.append(el('td', '', k), el('td', '', v));
    tb.append(tr);
  }
}

async function demoSettle() {
  const revenue = Number($('revenue').value || 0);
  const res = await fetch('/api/economy/settle', { method: 'POST', body: JSON.stringify({ revenue }) });
  if (!res.ok) return alert((await res.json()).error);
  preview();
}

// ---------- tabs & app shell ----------
const VIEWS = ['chats', 'calls', 'phone', 'settings', 'earn', 'security'];
const SUBVIEWS = { earn: 'settings', security: 'settings' }; // opened from Settings; back returns there
let currentTab = 'chats';
function switchTab(name) {
  currentTab = name;
  const navTab = SUBVIEWS[name] || name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === navTab);
  for (const v of VIEWS) $(`view-${v}`).classList.toggle('hidden', name !== v);
  if (name === 'earn') { wsSend({ type: 'account' }); preview(); }
  if (name === 'security') renderSecurity();
  if (name === 'phone') phone?.refresh();
  if (name === 'calls') renderCallLog();
  if (name === 'settings') renderSettings();
  // phones show one screen at a time: the chat list, a top-level section, or a deep screen
  if (name === 'chats') setScreen(active && !$('thread').classList.contains('hidden') ? 'deep' : 'list');
  else setScreen(SUBVIEWS[name] ? 'deep' : 'main');
}

/** list: chat list + bottom bar · main: a section + bottom bar · deep: one full screen (a chat, a sub-page). */
function setScreen(kind) {
  const app = $('app');
  app.classList.toggle('m-main', kind !== 'list');
  app.classList.toggle('m-deep', kind === 'deep');
}

function closeThread() {
  active = null;
  closeThreadMenu();
  closeThreadSearch();
  closeOutPreview();
  $('thread').classList.add('hidden');
  $('empty').classList.remove('hidden');
  renderContacts();
  setScreen('list');
}

function goBack() {
  if (SUBVIEWS[currentTab]) return switchTab(SUBVIEWS[currentTab]);
  if (currentTab !== 'chats') return switchTab('chats');
  closeThread();
}

// ---------- calls log ----------
const CALL_RE = /\bcall\b/i;
function renderCallLog() {
  const ul = $('call-log');
  ul.replaceChildren();
  const rows = [];
  for (const [h, list] of Object.entries(db.threads)) for (const m of list) if (m.from === '@system' && CALL_RE.test(m.text)) rows.push({ h, m });
  rows.sort((a, b) => b.m.ts - a.m.ts);
  if (!rows.length) { ul.append(el('li', 'contacts-empty', 'No calls yet.')); return; }
  for (const { h, m } of rows.slice(0, 100)) {
    const li = el('li', /missed|failed|no answer|declined/i.test(m.text) ? 'missed' : '');
    const mid = el('div', 'contact-main');
    const top = el('div', 'contact-top');
    top.append(el('span', 'contact-name', h), el('span', 'contact-time', shortWhen(m.ts)));
    mid.append(top, el('div', 'preview', m.text));
    const voice = el('button', 'icon-btn');
    voice.type = 'button'; voice.title = `Voice call ${h}`; voice.setAttribute('aria-label', voice.title);
    voice.append(svgIcon('M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z'));
    voice.onclick = (e) => { e.stopPropagation(); calls?.start(h, false); };
    const video = el('button', 'icon-btn');
    video.type = 'button'; video.title = `Video call ${h}`; video.setAttribute('aria-label', video.title);
    video.append(svgIcon('M3 6h13v12H3zM16 10l5-3v10l-5-3'));
    video.onclick = (e) => { e.stopPropagation(); calls?.start(h, true); };
    li.append(avatarEl(h), mid, voice, video);
    li.onclick = () => openThread(h);
    ul.append(li);
  }
}
function svgIcon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

function renderSettings() {
  if (!db?.handle) return;
  $('settings-avatar').replaceWith(Object.assign(avatarEl(db.handle, 'avatar big'), { id: 'settings-avatar' }));
  $('settings-handle').textContent = db.handle;
  $('settings-device').textContent = `${db.deviceName}${db.primary ? ' · primary device' : ' · linked device'}`;
}

// ---------- message actions: reply, react, copy, forward, edit, delete ----------
let composeCtx = null; // { mode: 'reply', quote } | { mode: 'edit', id }
let menuMsg = null;

function bindMessageMenu(li, m) {
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); openMsgMenu(m, li); });
  let timer = 0, sx = 0, sy = 0;
  li.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { timer = 0; navigator.vibrate?.(15); openMsgMenu(m, li); }, 450);
  });
  const cancel = () => { clearTimeout(timer); timer = 0; };
  li.addEventListener('pointerup', cancel);
  li.addEventListener('pointercancel', cancel);
  li.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'ContextMenu') { e.preventDefault(); openMsgMenu(m, li); } });
  const more = el('button', 'msg-more', '⌄');
  more.type = 'button';
  more.title = 'Message actions';
  more.setAttribute('aria-label', 'Message actions');
  more.onclick = (e) => { e.stopPropagation(); openMsgMenu(m, li); };
  li.append(more);
}

function openMsgMenu(m, li) {
  menuMsg = m;
  const mine = m.from === db.handle;
  const menu = $('msg-menu');
  const react = $('msg-react');
  react.replaceChildren();
  for (const e of QUICK_REACTIONS) {
    const b = el('button', 'react-pick' + (m.reactions?.[db.handle] === e ? ' mine' : ''), e);
    b.type = 'button';
    b.setAttribute('aria-label', `React with ${e}`);
    b.onclick = () => { closeMsgMenu(); window.react(m, m.reactions?.[db.handle] === e ? '' : e); };
    react.append(b);
  }
  react.classList.toggle('hidden', Boolean(m.deleted));
  const show = { reply: !m.deleted, copy: !m.deleted, forward: !m.deleted, edit: mine && !m.deleted, 'delete-all': mine && !m.deleted, 'delete-me': true };
  for (const [k, on] of Object.entries(show)) $(`msg-${k}`).classList.toggle('hidden', !on);
  menu.classList.remove('hidden');
  // next to the message, kept on screen
  const r = li.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let top = r.bottom + 4;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 4);
  const left = Math.min(Math.max(8, mine ? r.right - w : r.left), innerWidth - w - 8);
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.querySelector('button:not(.hidden)')?.focus();
}
function closeMsgMenu() { $('msg-menu').classList.add('hidden'); }

window.react = (m, emoji) => { if (active) sendAction(active, 'react', m.id, { emoji }); };
const react = window.react;

function setComposeCtx(ctx) {
  composeCtx = ctx;
  const bar = $('compose-ctx');
  bar.classList.toggle('hidden', !ctx);
  if (!ctx) return;
  $('compose-ctx-label').textContent = ctx.mode === 'edit' ? 'Editing message' : `Replying to ${ctx.quote.from === db.handle ? 'yourself' : ctx.quote.from}`;
  $('compose-ctx-text').textContent = ctx.mode === 'edit' ? ctx.original : ctx.quote.text;
  $('text').focus();
}
function clearComposeCtx() {
  if (composeCtx?.mode === 'edit') $('text').value = '';
  setComposeCtx(null);
  growText();
}

function jumpTo(id) {
  const li = $('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 1200);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch {
    const t = el('textarea'); t.value = text; document.body.append(t); t.select();
    try { document.execCommand('copy'); toast('Copied'); } catch { toast('Could not copy'); }
    t.remove();
  }
}
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 1600);
}

function openForward(m) {
  const list = $('fwd-list');
  list.replaceChildren();
  const handles = Object.keys(db.contacts).filter((h) => db.contacts[h].list && !db.contacts[h].pendingAccount).sort((a, b) => lastTs(b) - lastTs(a));
  if (!handles.length) list.append(el('li', 'contacts-empty', 'No contacts yet.'));
  for (const h of handles) {
    const b = el('button', 'fwd-to');
    b.type = 'button';
    b.append(avatarEl(h), el('span', 'contact-name', h));
    b.onclick = async () => {
      $('fwd-dialog').close();
      await sendText(m.text, null, { fwd: true }, h);
      toast(`Forwarded to ${h}`);
    };
    const item = el('li');
    item.append(b);
    list.append(item);
  }
  $('fwd-dialog').showModal();
}

// ---------- thread menu and in-chat search ----------
let threadQuery = '';
function closeThreadMenu() {
  $('thread-menu').classList.add('hidden');
  $('thread-menu-btn').setAttribute('aria-expanded', 'false');
}
function openThreadSearch(q = '') {
  closeThreadMenu();
  $('thread-search').classList.remove('hidden');
  $('thread-search-q').value = q;
  threadQuery = q.trim().toLowerCase();
  renderMessages();
  $('thread-search-q').focus();
}
function closeThreadSearch() {
  $('thread-search').classList.add('hidden');
  $('thread-search-count').textContent = '';
  if (threadQuery) { threadQuery = ''; if (active) renderMessages(); }
}

function showApp() {
  for (const id of ['onboard', 'unlock']) $(id).classList.add('hidden');
  $('app').classList.remove('hidden');
  $('me').textContent = db.handle;
  $('me-device').textContent = `${db.deviceName}${db.primary ? ' · primary' : ' · linked'}`;
  document.title = `FabriC++ · ${db.handle}`;
  renderContacts();
  setScreen('list');
}

function requestPersistentStorage() {
  // ask the browser not to evict the vault under storage pressure
  navigator.storage?.persist?.().catch(() => {});
}

/** Seal a new device's keys and state into the vault, then register it with the relay. */
async function startDevice(keys, state) {
  db = { ...fresh(), ...state };
  identity = await vault.create({ identity: keys, state: db });
  initSessions(); // ready before the relay asks for prekeys
  const ok = new Promise((resolve, reject) => { onboardWait = { resolve, reject }; });
  register();
  try {
    await ok;
  } catch (err) {
    await vault.destroy().catch(() => {});
    identity = null; sessions = null; db = fresh();
    throw err;
  }
  requestPersistentStorage();
  showApp();
}

// ---------- onboarding: new account ----------
$('onboard-form').onsubmit = async (e) => {
  e.preventDefault();
  $('onboard-error').textContent = '';
  const h = normalizeHandle($('onboard-handle').value);
  if (!isValidHandle(h)) { $('onboard-error').textContent = 'Use 2–24 letters, numbers or _.'; return; }
  if (!hello) { $('onboard-error').textContent = 'Relay not reachable yet — try again in a moment.'; return; }
  if (cidCfg.required && !cidPending) { $('onboard-error').textContent = 'Sign in with Cumulus://ID first.'; return; }
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    const keys = await generateUserIdentity();
    const accountKey = await generateSigningKey();
    const deviceId = newDeviceId();
    const deviceName = defaultDeviceName();
    const list = await signDeviceList(accountKey.privateJwk, {
      handle: h, version: 1, account: accountKey.publicJwk,
      devices: [{ id: deviceId, name: deviceName, dh: keys.dh.publicJwk, sig: keys.sig.publicJwk, addedAt: Date.now() }],
    });
    await startDevice({ ...keys, account: accountKey }, { handle: h, deviceId, deviceName, primary: true, self: { list }, ...(cidPending ? { cid: cidPending } : {}) });
    cidPending = null;
  } catch (err) {
    $('onboard-error').textContent = err.message;
    if (/Cumulus/.test(err.message)) { cidPending = null; renderCidOnboard(); }
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ---------- device linking ----------
// New device: shows a QR code (and the same code as text) holding its relay mailbox and an
// ephemeral key. Primary: scans or pastes it, and answers through the mailbox with its own
// ephemeral key and the account it is linking into. The new device replies, inside the
// channel, with its keys and a fresh nonce. Both then show a six-digit number over all of
// that (linkConfirmCode); the link completes only when the user confirms on both screens.
let linkNew = null; // state on the new device
const linkPrimary = new Map(); // mailbox -> { key, eph, pub } on the primary
let linkPending = null; // primary: { mailbox, key, device } waiting for the user's yes

function drawQr(canvas, text) {
  const m = qrMatrix(text);
  const quiet = 4;
  const n = m.length + quiet * 2;
  const scale = Math.max(2, Math.floor(232 / n));
  canvas.width = canvas.height = n * scale;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) {
    if (m[r][c]) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }
}

$('link-start').onclick = async () => {
  $('link-error').textContent = '';
  if (!hello) { $('link-error').textContent = 'Relay not reachable yet — try again in a moment.'; return; }
  const btn = $('link-start'); btn.disabled = true;
  try {
    const eph = await generateIdentity();
    const { id } = await request({ type: 'mailbox_open' });
    linkNew = {
      keys: await generateUserIdentity(), deviceId: newDeviceId(),
      deviceName: $('link-name').value.trim() || defaultDeviceName(), eph,
    };
    const code = encodeLinkCode(id, eph.publicJwk);
    $('link-code').textContent = code;
    drawQr($('link-qr'), code);
    $('link-wait').classList.remove('hidden');
    $('link-confirm').classList.add('hidden');
    $('link-status').textContent = 'Waiting for your primary device… The code works for 10 minutes while this page stays open.';
  } catch (err) {
    $('link-error').textContent = err.message;
    btn.disabled = false;
  }
};

$('link-copy').onclick = () => navigator.clipboard?.writeText($('link-code').textContent).catch(() => {});

$('link-sas-ok').onclick = () => {
  if (!linkNew?.sas) return;
  linkNew.confirmed = true;
  $('link-sas-ok').disabled = true;
  $('link-status').textContent = linkNew.done ? 'Finishing…' : 'Now confirm on your primary device too.';
  if (linkNew.done) joinLinked().catch(linkFailed);
};

$('link-sas-no').onclick = () => {
  if (linkNew?.peer) wsSend({ type: 'mailbox_send', to: linkNew.peer, payload: { type: 'link-cancel' } });
  linkNew = null;
  $('link-confirm').classList.add('hidden');
  $('link-wait').classList.add('hidden');
  $('link-start').disabled = false;
  $('link-error').textContent = 'Linking cancelled. Nothing was shared. Start again to get a new code.';
};

function linkFailed(err) {
  console.warn('link failed', err);
  if (linkNew) $('link-error').textContent = 'Linking failed: ' + err.message;
}

/** New device: the user confirmed and the primary's signed list is here. */
async function joinLinked() {
  const data = linkNew.done;
  const listPayload = await verifyDeviceList(data.list, { handle: linkNew.expect.handle, account: linkNew.expect.account });
  if (data.handle !== linkNew.expect.handle) throw new Error('The primary sent a different account.');
  const me = findDevice(listPayload, linkNew.deviceId);
  if (!me || keyId(me.dh) !== keyId(linkNew.keys.dh.publicJwk)) throw new Error('The primary sent a list without this device.');
  const { keys, deviceId, deviceName } = linkNew;
  linkNew = null;
  await startDevice(keys, {
    handle: data.handle, deviceId, deviceName, primary: false, self: { list: data.list },
    contacts: data.contacts || {}, threads: data.threads || {},
  });
}

function hideDevConfirm() {
  linkPending = null;
  $('dev-confirm').classList.add('hidden');
}

async function onMailbox(from, payload) {
  try {
    if (payload?.type === 'link-hello' && linkNew && !linkNew.peer
      && isPublicJwk(payload.ek) && isPublicJwk(payload.account) && isValidHandle(payload.handle)) {
      // new device: answer with our device keys and a nonce, over the channel only the code holder can open
      linkNew.key = await linkChannelKey(linkNew.eph.privateJwk, linkNew.eph.publicJwk, payload.ek);
      linkNew.peer = from;
      linkNew.expect = { account: publicOnly(payload.account), handle: payload.handle };
      const nonce = newLinkNonce();
      const box = await sealJson(linkNew.key, LINK_DEVICE, {
        id: linkNew.deviceId, name: linkNew.deviceName,
        dh: linkNew.keys.dh.publicJwk, sig: linkNew.keys.sig.publicJwk, nonce,
      });
      wsSend({ type: 'mailbox_send', to: from, payload: { type: 'link-device', box } });
      linkNew.sas = await linkConfirmCode({
        deviceEph: linkNew.eph.publicJwk, primaryEph: payload.ek, account: payload.account, handle: payload.handle, nonce,
      });
      $('link-sas').textContent = linkNew.sas;
      $('link-confirm').classList.remove('hidden');
      $('link-status').textContent = `Joining ${payload.handle}. Compare the numbers.`;
      return;
    }
    if (payload?.type === 'link-done' && linkNew?.key && from === linkNew.peer) {
      linkNew.done = await openJson(linkNew.key, LINK_DONE, payload.box);
      if (linkNew.confirmed) await joinLinked();
      else $('link-status').textContent = 'Your primary device confirmed. Check the number and confirm here.';
      return;
    }
    if (payload?.type === 'link-cancel') {
      if (linkNew && from === linkNew.peer) {
        linkNew = null;
        $('link-confirm').classList.add('hidden');
        $('link-wait').classList.add('hidden');
        $('link-start').disabled = false;
        $('link-error').textContent = 'Your primary device cancelled. Start again to get a new code.';
      }
      if (linkPending?.mailbox === from) {
        hideDevConfirm();
        $('dev-msg').className = 'error small';
        $('dev-msg').textContent = 'The new device said the numbers differ. Nothing was linked.';
      }
      return;
    }
    if (payload?.type === 'link-device' && linkPrimary.has(from)) return askToLink(from, payload);
  } catch (err) {
    linkFailed(err);
    const s = linkPrimary.get(from);
    if (s || linkPending?.mailbox === from) {
      $('dev-msg').className = 'error small'; $('dev-msg').textContent = 'Linking failed: ' + err.message;
      linkPrimary.delete(from);
      hideDevConfirm();
    }
  }
}

/** History and contacts for a new device: no sessions, no pending copies. */
function portableState() {
  const contacts = {};
  for (const [h, c] of Object.entries(db.contacts)) {
    if (c.account && c.list) contacts[h] = { account: c.account, list: c.list, verified: c.verified, addedAt: c.addedAt, dk: c.dk };
  }
  const threads = {};
  for (const [h, t] of Object.entries(db.threads)) {
    threads[h] = t.slice(-HISTORY_SNAPSHOT).map(({ out, anyQueued, okCopies, failedCopies, lastError, ...m }) => m);
  }
  return { contacts, threads };
}

/** Primary: start linking the device behind a scanned or pasted code. */
async function startLink(codeText) {
  const msg = $('dev-msg');
  msg.className = 'small'; msg.textContent = '';
  try {
    if (!identity.account) throw new Error('Only the primary device can link devices.');
    if (myDevices().length >= MAX_DEVICES) throw new Error(`An account can have up to ${MAX_DEVICES} devices. Remove one first.`);
    const { mailbox, pub } = decodeLinkCode(codeText);
    const eph = await generateIdentity();
    const key = await linkChannelKey(eph.privateJwk, eph.publicJwk, pub);
    linkPrimary.set(mailbox, { key, eph, pub });
    await request({ type: 'mailbox_send', to: mailbox, payload: { type: 'link-hello', ek: eph.publicJwk, account: myAccountKey(), handle: db.handle } });
    msg.textContent = 'Contacting the new device…';
  } catch (err) {
    msg.className = 'error small'; msg.textContent = err.message;
  }
}

$('dev-link-form').onsubmit = (e) => {
  e.preventDefault();
  startLink($('dev-code').value);
};

/** Primary: the new device answered. Show the number and wait for the user. */
async function askToLink(mailbox, payload) {
  const { key, eph, pub } = linkPrimary.get(mailbox);
  linkPrimary.delete(mailbox);
  const d = await openJson(key, LINK_DEVICE, payload.box); // only the code holder can produce this
  if (!DEVICE_ID_RE.test(d.id) || !isPublicJwk(d.dh) || !isPublicJwk(d.sig) || !LINK_NONCE_RE.test(String(d.nonce))) throw new Error('bad device keys');
  const device = { id: d.id, name: String(d.name || 'Device').slice(0, 40), dh: publicOnly(d.dh), sig: publicOnly(d.sig), addedAt: Date.now() };
  const sas = await linkConfirmCode({ deviceEph: pub, primaryEph: eph.publicJwk, account: myAccountKey(), handle: db.handle, nonce: d.nonce });
  linkPending = { mailbox, key, device };
  $('dev-sas').textContent = sas;
  $('dev-confirm').classList.remove('hidden');
  $('dev-msg').className = 'small';
  $('dev-msg').textContent = `"${device.name}" wants to join. Compare the numbers on both screens.`;
}

$('dev-sas-ok').onclick = async () => {
  if (!linkPending) return;
  const { mailbox, key, device } = linkPending;
  hideDevConfirm();
  try {
    const list = await signDeviceList(identity.account.privateKey, nextDeviceList(db.self.list.payload, { add: [device] }));
    await request({ type: 'update_devices', list });
    db.self.list = list;
    await persist();
    const box = await sealJson(key, LINK_DONE, { handle: db.handle, list, ...portableState() });
    await request({ type: 'mailbox_send', to: mailbox, payload: { type: 'link-done', box } });
    $('dev-code').value = '';
    $('dev-msg').className = 'small';
    $('dev-msg').textContent = `Linked ${device.name}. Confirm on the new device as well if you haven't.`;
  } catch (err) {
    $('dev-msg').className = 'error small'; $('dev-msg').textContent = 'Linking failed: ' + err.message;
  }
  renderSecurity();
};

$('dev-sas-no').onclick = () => {
  if (linkPending) wsSend({ type: 'mailbox_send', to: linkPending.mailbox, payload: { type: 'link-cancel' } });
  hideDevConfirm();
  $('dev-msg').className = 'small';
  $('dev-msg').textContent = 'Cancelled. Nothing was linked.';
};

// ---------- QR scanning (primary) ----------
// BarcodeDetector where the browser has it, otherwise jsQR (served by the relay from
// node_modules, so the page still loads no third-party script). Frames never leave the page.
let scan = null; // { stream, timer }
let jsQRLoad = null;

function loadJsQR() {
  jsQRLoad ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = '/vendor/jsqr.js';
    tag.onload = () => (globalThis.jsQR ? resolve(globalThis.jsQR) : reject(new Error('QR reader did not load')));
    tag.onerror = () => { jsQRLoad = null; reject(new Error('QR reader did not load')); };
    document.head.append(tag);
  });
  return jsQRLoad;
}

/** Read a QR code from a video or canvas. Returns its text or null. */
async function readQr(source) {
  if ('BarcodeDetector' in globalThis) {
    try {
      const found = await new globalThis.BarcodeDetector({ formats: ['qr_code'] }).detect(source);
      if (found[0]) return found[0].rawValue;
      if (source instanceof HTMLCanvasElement) return null;
    } catch { /* not supported for this source: fall back */ }
  }
  const jsQR = await loadJsQR();
  const w = source.videoWidth || source.width;
  const h = source.videoHeight || source.height;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, w, h);
  return jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

function stopScan() {
  if (!scan) return;
  clearInterval(scan.timer);
  for (const t of scan.stream.getTracks()) t.stop();
  $('dev-video').srcObject = null;
  $('dev-scanner').classList.add('hidden');
  scan = null;
}

$('dev-scan').onclick = async () => {
  const msg = $('dev-msg');
  msg.className = 'small'; msg.textContent = '';
  if (scan) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = $('dev-video');
    video.srcObject = stream;
    await video.play();
    $('dev-scanner').classList.remove('hidden');
    let busy = false;
    scan = {
      stream,
      timer: setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const text = await readQr(video);
          if (text?.startsWith('FAB1.')) { stopScan(); startLink(text); }
        } catch (err) {
          stopScan(); msg.className = 'error small'; msg.textContent = err.message;
        } finally { busy = false; }
      }, 250),
    };
  } catch (err) {
    stopScan();
    msg.className = 'error small';
    msg.textContent = err.name === 'NotAllowedError' ? 'Camera access was refused. Paste the code instead.'
      : err.name === 'NotFoundError' ? 'No camera found. Paste the code instead.' : err.message;
  }
};
$('dev-scan-stop').onclick = stopScan;

// test hook (only with ?media=test): read a QR code from a canvas through the same reader
if (new URLSearchParams(location.search).get('media') === 'test') {
  globalThis.__fabricQr = { draw: drawQr, read: readQr, startLink };
}

async function removeDevice(id) {
  const msg = $('dev-msg');
  try {
    const list = await signDeviceList(identity.account.privateKey, nextDeviceList(db.self.list.payload, { remove: [id] }));
    await request({ type: 'update_devices', list });
    db.self.list = list;
    await sessions.reset(deviceAddr(db.handle, id));
    msg.className = 'small'; msg.textContent = 'Device removed. It can no longer send or receive as you.';
  } catch (err) {
    msg.className = 'error small'; msg.textContent = err.message;
  }
  renderSecurity();
}

// ---------- backup & restore ----------
/** An encrypted backup, under the recovery key typed in (if any) or a new one. */
async function makeBackup() {
  const typed = $('backup-reuse').value.trim();
  if (typed) parseRecoveryKey(typed); // throws a readable error for a mistyped key
  const accountKey = await vault.exportIdentityPart('account', $('backup-pass').value || null);
  const recovery = typed || newRecoveryKey();
  const file = await sealBackup(recovery, { v: 3, handle: db.handle, account: accountKey, ...portableState() });
  $('backup-pass').value = '';
  $('backup-reuse').value = '';
  if (typed) {
    $('backup-result').classList.add('hidden');
  } else {
    $('backup-key').textContent = recovery;
    $('backup-result').classList.remove('hidden');
  }
  return { file, reused: Boolean(typed) };
}

$('backup-form').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('backup-msg');
  msg.className = 'small'; msg.textContent = '';
  try {
    const { file, reused } = await makeBackup();
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fabric-backup-${db.handle.slice(1).replace('.veil', '')}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    msg.textContent = reused ? 'Backup file downloaded. It opens with the recovery key you entered.' : 'Backup file downloaded.';
  } catch (err) {
    msg.className = 'error small'; msg.textContent = err.message;
  }
};

$('restore-form').onsubmit = async (e) => {
  e.preventDefault();
  $('restore-error').textContent = '';
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    if (!hello) throw new Error('Relay not reachable yet — try again in a moment.');
    const fileEl = $('restore-file');
    let file = cloudBackup;
    if (!file) {
      if (!fileEl.files?.[0]) throw new Error('Choose your backup file, or sign in with Cumulus://ID.');
      try { file = JSON.parse(await fileEl.files[0].text()); } catch { throw new Error('That is not a FabriC++ backup file.'); }
    }
    const content = await openBackup($('restore-key').value, file);
    const accountKey = content.account;
    // continue the account's signed device list (or start one if the relay forgot it)
    let base = { v: 3, handle: content.handle, version: 0, account: accountKey.publicJwk, devices: [] };
    const current = await request({ type: 'lookup', handle: content.handle }).then((m) => m.list).catch(() => null);
    if (current) base = await verifyDeviceList(current, { handle: content.handle, account: accountKey.publicJwk });
    if (base.devices.length >= MAX_DEVICES) throw new Error(`The account already has ${MAX_DEVICES} devices.`);
    const keys = await generateUserIdentity();
    const deviceId = newDeviceId();
    const deviceName = defaultDeviceName();
    const list = await signDeviceList(accountKey.privateJwk, nextDeviceList(base, {
      add: [{ id: deviceId, name: deviceName, dh: keys.dh.publicJwk, sig: keys.sig.publicJwk, addedAt: Date.now() }],
    }));
    await startDevice({ ...keys, account: accountKey }, {
      handle: content.handle, deviceId, deviceName, primary: true, self: { list },
      contacts: content.contacts || {}, threads: content.threads || {},
      ...(cloudBackup && cloudWho ? { cid: cloudWho } : {}),
    });
    $('restore-key').value = '';
    cloudBackup = null; cloudWho = null;
    for (const h of Object.keys(db.threads)) systemLine(h, 'Restored from backup on a new device.');
    persist(); renderContacts();
  } catch (err) {
    $('restore-error').textContent = err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ---------- Cumulus://ID ----------
// Sign-in runs in a window of its own. CID sends it back to /cid-callback.html, which passes the
// code here over a BroadcastChannel; the code goes to the relay on the socket that started the
// sign-in, and the relay swaps it for an ID token. No CID token ever reaches this page.
const cidWaits = new Map(); // state -> { resolve, reject }
const cidChannel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('fabric-cid') : null;
if (cidChannel) {
  cidChannel.onmessage = (e) => {
    const d = e.data;
    const w = d?.type === 'code' && cidWaits.get(d.state);
    if (!w) return; // another tab's sign-in
    cidWaits.delete(d.state);
    cidChannel.postMessage({ type: 'taken', state: d.state });
    w.resolve(d);
  };
}
let cidPending = null; // { email, name } after a sign-in for a new address
let cloudBackup = null; // backup file fetched from Cumulus for restoring
let cloudWho = null;

/**
 * `note` is where to say what's happening; when pop-ups are blocked, it gets a link that opens
 * the sign-in in a new tab instead (the code still comes back over the BroadcastChannel).
 */
async function cidSignIn(purpose, note) {
  if (!cidChannel) throw new Error('This browser cannot do Cumulus://ID sign-in.');
  if (!hello) throw new Error('Relay not reachable yet — try again in a moment.');
  // opened right away, inside the tap, so pop-up blockers allow it
  const win = window.open('', 'fabric-cid', 'popup,width=480,height=700');
  let started;
  try { started = await request({ type: 'cid_begin', purpose }); } catch (e) { win?.close(); throw e; }
  if (win) {
    win.location.href = started.url;
    note.className = 'muted small';
    note.textContent = 'Finish signing in in the Cumulus://ID window.';
  } else {
    const a = el('a', '', 'Continue to Cumulus://ID');
    a.href = started.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    note.className = 'small';
    note.replaceChildren(document.createTextNode('Pop-ups are blocked here. '), a, document.createTextNode(' (opens a new tab).'));
  }
  const back = await new Promise((resolve, reject) => {
    cidWaits.set(started.state, { resolve, reject });
    setTimeout(() => { if (cidWaits.delete(started.state)) reject(new Error('Sign-in timed out. Try again.')); }, 10 * 60_000);
  }).finally(() => { note.textContent = ''; });
  if (back.error) throw new Error(back.error === 'access_denied' ? 'Sign-in cancelled.' : `Cumulus://ID: ${back.errorDescription || back.error}`);
  return request({ type: 'cid_finish', state: started.state, code: back.code });
}

const who = (r) => r?.email || r?.name || 'your Cumulus://ID';
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function renderCidOnboard() {
  $('cid-restore-box').classList.toggle('hidden', !cidCfg.enabled);
  $('cid-required').classList.toggle('hidden', !cidCfg.required);
  $('cid-register-who').textContent = cidPending ? `Signed in as ${who(cidPending)}. Now pick your address.` : '';
  $('cid-register').classList.toggle('hidden', Boolean(cidPending));
}

$('cid-register').onclick = async () => {
  $('onboard-error').textContent = '';
  try {
    const r = await cidSignIn('register', $('cid-register-who'));
    cidPending = { email: r.email, name: r.name };
  } catch (err) { $('onboard-error').textContent = err.message; }
  renderCidOnboard();
};

$('cid-restore').onclick = async () => {
  const note = $('cid-restore-note');
  $('restore-error').textContent = '';
  note.textContent = '';
  cloudBackup = null; cloudWho = null;
  $('restore-file-row').classList.remove('hidden');
  try {
    const r = await cidSignIn('restore', note);
    if (!r.handle) throw new Error(`No FabriC++ address is linked to ${who(r)}.`);
    if (!r.backup) throw new Error(`${r.handle} is linked to ${who(r)}, but has no backup in Cumulus. Link this device from your other device, or use a backup file.`);
    const res = await fetch(`/api/cid/backup?ticket=${encodeURIComponent(r.backup.ticket)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not fetch the backup. Try again.');
    const file = await res.json();
    if (file.handle !== r.handle) throw new Error('The backup from Cumulus is for another address.');
    cloudBackup = file;
    cloudWho = { email: r.email, name: r.name };
    $('restore-file-row').classList.add('hidden');
    note.textContent = `Found the backup of ${r.handle} from ${new Date(r.backup.updatedAt).toLocaleString()}. Enter its recovery key.`;
    $('restore-key').focus();
  } catch (err) {
    $('restore-error').textContent = err.message;
  }
};

function renderCid() {
  const on = Boolean(cidState?.enabled ?? cidCfg.enabled);
  $('cid-card').classList.toggle('hidden', !on);
  $('backup-cloud').classList.toggle('hidden', !(on && cidState?.linked));
  if (!on) return;
  const rows = [['Status', cidState?.linked
    ? `Linked${db.cid ? ` as ${who(db.cid)}` : ''} since ${new Date(cidState.linkedAt).toLocaleDateString()}`
    : 'Not linked']];
  if (cidState?.linked) rows.push(['Backup in Cumulus', cidState.backup ? `Saved ${new Date(cidState.backup.updatedAt).toLocaleString()} · ${fmtSize(cidState.backup.size)}` : 'None yet: use Save to Cumulus under Backup']);
  if (cidState?.required) rows.push(['New addresses', 'This relay asks every new address to have a Cumulus://ID']);
  const tb = $('cid-status');
  tb.replaceChildren();
  for (const [k, v] of rows) { const tr = el('tr'); tr.append(el('th', '', k), el('td', '', v)); tb.append(tr); }
  $('cid-link').classList.toggle('hidden', Boolean(cidState?.linked) || !db.primary);
  $('cid-unlink').classList.toggle('hidden', !cidState?.linked || !db.primary);
  $('cid-primary-note').classList.toggle('hidden', db.primary);
}

$('cid-link').onclick = async () => {
  const msg = $('cid-msg');
  msg.className = 'small'; msg.textContent = '';
  try {
    const r = await cidSignIn('link', msg);
    db.cid = { email: r.email, name: r.name };
    persist();
    msg.textContent = `Linked to ${who(r)}.`;
  } catch (err) { msg.className = 'error small'; msg.textContent = err.message; }
  renderCid();
};

$('cid-unlink').onclick = async () => {
  const msg = $('cid-msg');
  if (!confirm('Unlink your Cumulus://ID? The backup stored in Cumulus is deleted too. Backup files you downloaded still work.')) return;
  msg.className = 'small'; msg.textContent = '';
  try {
    await request({ type: 'cid_unlink' });
    delete db.cid; persist();
    msg.textContent = 'Unlinked. The backup in Cumulus is deleted.';
  } catch (err) { msg.className = 'error small'; msg.textContent = err.message; }
};

$('backup-cloud').onclick = async () => {
  const msg = $('backup-msg');
  const btn = $('backup-cloud');
  msg.className = 'small'; msg.textContent = '';
  btn.disabled = true;
  try {
    const { ticket, maxBytes } = await request({ type: 'cid_backup_ticket' });
    const { file, reused } = await makeBackup();
    const body = JSON.stringify(file);
    if (body.length > maxBytes) throw new Error(`The backup is ${fmtSize(body.length)}, more than Cumulus takes here (${fmtSize(maxBytes)}). Download a backup file instead.`);
    const res = await fetch(`/api/cid/backup?ticket=${encodeURIComponent(ticket)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed.');
    msg.textContent = reused
      ? 'Saved to Cumulus. It opens with the recovery key you entered.'
      : 'Saved to Cumulus. It opens only with the recovery key shown here: older recovery keys no longer open the copy in Cumulus.';
  } catch (err) {
    msg.className = 'error small'; msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

fetch('/api/cid', { cache: 'no-store' }).then((r) => r.json()).then((c) => {
  cidCfg = { enabled: Boolean(c.enabled), required: Boolean(c.required) };
  renderCidOnboard();
  renderCid();
}).catch(() => {});

// ---------- unlock, migration, upgrade ----------
function opened(result) {
  identity = result.identity;
  db = { ...fresh(), ...result.state };
  initSessions();
  showApp();
  if (hello) register();
}

/** v0.3 vaults have no account key or device id: this device becomes the primary. */
async function upgradeToMultiDevice() {
  const accountJwk = await generateSigningKey();
  identity.account = await vault.addIdentityPart('account', accountJwk);
  db.deviceId = newDeviceId();
  db.deviceName = defaultDeviceName();
  db.primary = true;
  db.self = {
    list: await signDeviceList(accountJwk.privateJwk, {
      handle: db.handle, version: 1, account: accountJwk.publicJwk,
      devices: [{ id: db.deviceId, name: db.deviceName, dh: identity.dh.publicJwk, sig: identity.sig.publicJwk, addedAt: Date.now() }],
    }),
  };
  for (const [h, c] of Object.entries(db.contacts)) {
    db.contacts[h] = { verified: false, addedAt: c.addedAt }; // re-pinned on next lookup
    systemLine(h, 'FabriC++ now supports several devices. Check the safety number with this contact again.');
  }
  db.crypto.sessions = {}; // old sessions were per account; new ones are per device
  db.held = {};
  await persist();
}

async function migrateLegacy() {
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch { /* unreadable: ignore */ }
  if (!legacy?.identity?.dh?.privateJwk) return false;
  const { identity: jwks, ...rest } = legacy;
  await vault.create({ identity: jwks, state: { ...fresh(), ...rest } });
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* storage blocked */ } // the plaintext copy is gone once the vault holds it
  return true;
}

async function openVault(passphrase = null) {
  const result = await vault.unlock(passphrase);
  identity = result.identity;
  db = { ...fresh(), ...result.state };
  if (!db.deviceId) await upgradeToMultiDevice();
  opened({ identity, state: db });
}

async function boot() {
  connect();
  if (!(await vault.exists())) await migrateLegacy();
  const meta = await vault.meta();
  if (meta?.mode === 'passphrase') {
    $('unlock').classList.remove('hidden');
    $('unlock-pass').focus();
    return;
  }
  if (meta) return openVault();
  $('onboard').classList.remove('hidden');
}

$('unlock-form').onsubmit = async (e) => {
  e.preventDefault();
  $('unlock-error').textContent = '';
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    await openVault($('unlock-pass').value);
    $('unlock-pass').value = '';
  } catch (err) {
    $('unlock-error').textContent = err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ---------- security tab ----------
function sealedSummary() {
  const all = Object.values(db.contacts).filter((c) => c.list);
  const n = all.filter((c) => isDeliveryKey(c.dk)).length;
  return `On. To ${n} of ${all.length} contacts, the relay can't see that messages and calls come from you. `
    + 'The rest go named until they send you a message.';
}
async function renderSecurity() {
  const meta = await vault.meta();
  const withPass = meta?.mode === 'passphrase';
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const rows = [
    ['This device', `${db.deviceName} · ${db.primary ? 'primary (holds the account key)' : 'linked'}`],
    ['Identity keys', 'Non-extractable. This page can use them but cannot read them out.'],
    ['Local data', 'Messages, contacts and ratchet sessions are encrypted (AES-256-GCM) in IndexedDB.'],
    ['Protection', withPass
      ? `Passphrase (PBKDF2-SHA256, ${meta.kdf.iterations.toLocaleString()} iterations). Needed after every reload.`
      : 'Device key only. Anyone with this browser profile can open FabriC++. Set a passphrase to stop that.'],
    ['Sealed sender', sealedSummary()],
    ['Storage', persisted ? 'Persistent: the browser will not clear it on its own.' : 'Best-effort: the browser may clear it under storage pressure.'],
  ];
  const tb = $('sec-status');
  tb.replaceChildren();
  for (const [k, v] of rows) { const tr = el('tr'); tr.append(el('th', '', k), el('td', '', v)); tb.append(tr); }
  $('sec-current-row').classList.toggle('hidden', !withPass);
  $('sec-remove').classList.toggle('hidden', !withPass);
  $('sec-lock').classList.toggle('hidden', !withPass);
  $('sec-submit').textContent = withPass ? 'Change passphrase' : 'Set passphrase';

  // devices
  const ul = $('dev-list');
  ul.replaceChildren();
  for (const d of myDevices()) {
    const li = el('li', 'device');
    const info = el('div');
    info.append(el('b', '', d.name + (d.id === db.deviceId ? ' (this device)' : '')),
      el('div', 'muted small', `Added ${new Date(d.addedAt).toLocaleDateString()} · ${d.id.slice(0, 8)}`));
    li.append(info);
    if (db.primary && d.id !== db.deviceId) {
      const b = el('button', 'ghost', 'Remove');
      b.onclick = () => removeDevice(d.id);
      li.append(b);
    }
    ul.append(li);
  }
  $('dev-link-form').classList.toggle('hidden', !db.primary);
  $('dev-linked-note').classList.toggle('hidden', db.primary);
  $('backup-card').classList.toggle('hidden', !db.primary);
  $('backup-pass-row').classList.toggle('hidden', !withPass);
  renderAiStatus();
  renderCid();
}

$('sec-form').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('sec-msg');
  msg.className = 'small'; msg.textContent = '';
  const next = $('sec-new').value;
  if (next.length < MIN_PASSPHRASE) { msg.className = 'error small'; msg.textContent = `Use at least ${MIN_PASSPHRASE} characters.`; return; }
  if (next !== $('sec-confirm').value) { msg.className = 'error small'; msg.textContent = 'The two passphrases do not match.'; return; }
  const btn = $('sec-submit'); btn.disabled = true; msg.textContent = 'Re-encrypting…';
  try {
    await vault.setPassphrase(next, $('sec-current').value || null);
    for (const id of ['sec-new', 'sec-confirm', 'sec-current']) $(id).value = '';
    msg.textContent = 'Passphrase saved. You will need it after every reload.';
  } catch (err) {
    msg.className = 'error small'; msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    renderSecurity();
  }
};

$('sec-remove').onclick = async () => {
  const msg = $('sec-msg');
  msg.className = 'small'; msg.textContent = '';
  try {
    await vault.setPassphrase(null, $('sec-current').value || null);
    $('sec-current').value = '';
    msg.textContent = 'Passphrase removed. This device opens FabriC++ without one.';
  } catch (err) {
    msg.className = 'error small'; msg.textContent = err.message;
  }
  renderSecurity();
};

$('sec-lock').onclick = async () => {
  await persist().catch(() => {});
  vault.lock();
  location.reload(); // drops every key from memory
};

$('revoked-reset').onclick = async () => {
  await vault.destroy().catch(() => {});
  location.reload();
};

// onboarding: switch between create / link / restore
for (const b of document.querySelectorAll('[data-onboard]')) {
  b.onclick = () => {
    for (const p of document.querySelectorAll('.onboard-panel')) p.classList.toggle('hidden', p.id !== `panel-${b.dataset.onboard}`);
    for (const x of document.querySelectorAll('[data-onboard]')) x.classList.toggle('active', x === b);
  };
}

$('add-contact').onsubmit = async (e) => {
  e.preventDefault();
  $('add-error').textContent = '';
  try { await addContact($('add-handle').value); $('add-handle').value = ''; } catch (err) { $('add-error').textContent = err.message; }
};
$('composer').onsubmit = (e) => {
  e.preventDefault();
  const t = $('text').value.trim();
  if (!t || !active) return;
  if (composeCtx?.mode === 'edit') {
    const id = composeCtx.id;
    clearComposeCtx();
    if (t !== findMessage(id)?.m.text) sendAction(active, 'edit', id, { text: t });
    return;
  }
  const to = aiPrefs().out[active];
  if (to) return previewOut(active, t, to);
  $('text').value = '';
  sendText(t);
};
$('translate-out').onchange = (e) => {
  if (!active) return;
  const v = e.target.value;
  if (LANG_RE.test(v)) aiPrefs().out[active] = v; else delete aiPrefs().out[active];
  persist();
  closeOutPreview();
  if (v) wsSend({ type: 'feature', feature: 'translate_out' }); // counted only if Product research is opted in
};
$('show-safety').onclick = showSafety;
$('call-voice').onclick = () => active && calls?.start(active, false);
$('call-video').onclick = () => active && calls?.start(active, true);
$('summarize').onclick = showSummary;
$('preview-form').onsubmit = (e) => { e.preventDefault(); preview(); };
$('settle').onclick = demoSettle;
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => switchTab(b.dataset.tab);
for (const b of document.querySelectorAll('[data-back]')) b.onclick = goBack;
$('back').onclick = closeThread;
for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => {
  switchTab(b.dataset.go);
  if (b.dataset.focus) $(b.dataset.focus)?.scrollIntoView({ block: 'start' });
};
$('add-handle').oninput = () => { $('add-error').textContent = ''; renderContacts(); };
$('new-chat').onclick = () => {
  if (active) closeThread(); else switchTab('chats');
  const i = $('add-handle');
  if (!i.value.startsWith('@')) i.value = '@';
  i.focus();
};
$('thread-menu-btn').onclick = (e) => {
  e.stopPropagation();
  const open = $('thread-menu').classList.toggle('hidden') === false;
  $('thread-menu-btn').setAttribute('aria-expanded', String(open));
};
$('thread-menu').addEventListener('click', () => closeThreadMenu());
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeThreadMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('msg-menu').classList.contains('hidden')) closeMsgMenu();
  else if (composeCtx) clearComposeCtx();
  else if (!$('thread-menu').classList.contains('hidden')) closeThreadMenu();
  else if (!$('thread-search').classList.contains('hidden')) closeThreadSearch();
});
$('thread-search-btn').onclick = () => openThreadSearch();
$('msg-reply').onclick = () => { const m = menuMsg; closeMsgMenu(); if (m) setComposeCtx({ mode: 'reply', quote: quoteOf(m) }); };
$('msg-copy').onclick = () => { const m = menuMsg; closeMsgMenu(); if (m) copyText(m.text); };
$('msg-forward').onclick = () => { const m = menuMsg; closeMsgMenu(); if (m) openForward(m); };
$('msg-edit').onclick = () => {
  const m = menuMsg; closeMsgMenu();
  if (!m) return;
  setComposeCtx({ mode: 'edit', id: m.id, original: m.text });
  $('text').value = m.text; growText();
};
$('msg-delete-all').onclick = () => {
  const m = menuMsg; closeMsgMenu();
  if (m && active && confirm('Delete this message for everyone in the chat?')) sendAction(active, 'delete', m.id);
};
$('msg-delete-me').onclick = () => {
  const m = menuMsg; closeMsgMenu();
  if (!m || !active || !confirm('Delete this message from this device? Others keep their copy.')) return;
  db.threads[active] = db.threads[active].filter((x) => x !== m);
  persist(); renderMessages(); renderContacts();
};
$('compose-ctx-close').onclick = clearComposeCtx;
$('fwd-cancel').onclick = () => $('fwd-dialog').close();
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#msg-menu')) closeMsgMenu(); }, true);
$('messages').addEventListener('scroll', closeMsgMenu, { passive: true });
$('thread-search-close').onclick = closeThreadSearch;
$('thread-search').onsubmit = (e) => e.preventDefault();
$('thread-search-q').oninput = (e) => { threadQuery = e.target.value.trim().toLowerCase(); renderMessages(); };
$('clear-chat').onclick = () => {
  if (!active || !confirm(`Delete every message with ${active} from this device? They keep their copy.`)) return;
  db.threads[active] = [];
  persist(); renderMessages(); renderContacts();
};
// Enter sends on a keyboard (Shift+Enter adds a line); on phones Enter is a new line and the button sends
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
const growText = () => { const t = $('text'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; };
$('text').addEventListener('input', growText);
$('composer').addEventListener('submit', () => setTimeout(growText));

boot();
