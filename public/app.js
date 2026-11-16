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
import { startHandleDisplay } from '/handle-display.js';
import { linkChannelKey, sealJson, openJson, newRecoveryKey, parseRecoveryKey, sealBackup, openBackup } from '/shared/channel.js';
import { Vault, MIN_PASSPHRASE } from '/shared/vault.js';
import { idbBackend } from '/idb.js';
import { PURPOSES } from '/shared/economy.js';
import { createAi, installFakeModels, hideBuiltInModels } from '/ai.js';
import { languageName } from '/shared/ai.js';
import { normalizePrefs, translatingIn, toggleChat, setAuto, shouldAsk, noteFor, stillCurrent, theirLanguage, offerReplyIn, textHash } from '/shared/translate.js';
import { TRANSLATION_LANGS } from '/shared/models.js';
import { createCalls } from '/calls.js';
import { createPhone, toE164, formatNumber } from '/phone.js';
import { mountDialpad, isTouch } from '/dialpad.js';
import { mountSpaces } from '/spaces.js';
import { seal, peekSealed, openSealed, isDeliveryKey } from '/shared/sealed.js';
import { applyAction, actionPayload, quoteOf, extrasOf, reactionSummary, QUICK_REACTIONS, isTtl, ttlLabel } from '/shared/actions.js';
import {
  mediaOf, mediaLabel, fmtBytes, fmtDuration, MAX_MEDIA_BYTES, receiptPayload, applyReceipt, unreadFrom,
  freshTyping, TYPING_SEND_EVERY, TYPING_SHOW_FOR, groupOf, newGroup, mergeGroup, groupKey, isGroupKey, groupIdOf,
  orderChats, MAX_PINNED,
} from '/shared/chat.js';
import { installDesk, SAVED, plainText } from '/desk.js';
import { installBots } from '/bots-ui.js';
import { isBotHandle } from '/shared/bots.js';
import { avatarOf, isNewer, needsProfile, profilePayload, AVATAR_PX } from '/shared/profile.js';
import { waExtrasOf, dropFromBlocked, mentionsMe } from '/shared/wa.js';
import { installWa } from '/wa.js';
import { installStatus } from '/status.js';
import { installExtras } from '/extras.js';
import { i18n } from './i18n/start.js'; // interface language: build-time catalogs, no runtime calls

// ---------- local vault (keys + history stay on this device, encrypted) ----------
// ?profile=name lets several devices/accounts run side by side in one browser for testing.
const PROFILE = new URLSearchParams(location.search).get('profile') || 'default';
const LEGACY_KEY = `fabric:v2:${PROFILE}`; // v0.2 kept everything in plain localStorage; migrated once
const vault = new Vault(idbBackend(`fabric-${PROFILE}`));
const THEME_KEY = 'fabric-theme-v2'; // v1 stored 'system' for everyone; white is the default now
function applyTheme(t) {
  const theme = ['dark', 'system'].includes(t) ? t : 'light';
  if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage off: still applied for now */ }
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  try { window.FabricShell?.setDarkBars?.(dark); } catch { /* not in the Android app */ }
}
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { applyTheme('system'); }
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* */ } });

const LINK_DEVICE = 'FABRIC/v3/link/device';
const LINK_DONE = 'FABRIC/v3/link/done';
const HISTORY_SNAPSHOT = 200; // messages per conversation copied to a newly linked device
const REFRESH_MS = 15_000;

const fresh = () => ({
  handle: null, deviceId: null, deviceName: null, primary: false, self: null,
  contacts: {}, threads: {}, unread: {}, held: {}, crypto: emptyStore(), seen: [],
  groups: {}, chatPrefs: {}, prefs: { receipts: true, typing: true, notify: false },
});
// on-device AI (public/ai.js): ?media=test&ai=fake swaps in a stand-in model for testing, and
// ?media=test&ai=open hides the browser's built-in model so the open models run instead
const QS_AI = new URLSearchParams(location.search);
if (QS_AI.get('media') === 'test' && QS_AI.get('ai') === 'fake') installFakeModels();
if (QS_AI.get('media') === 'test' && QS_AI.get('ai') === 'open') hideBuiltInModels();
const ai = createAi({ target: i18n.locale }); // messages translate into the interface language
i18n.subscribe(() => ai.setTarget(i18n.locale));
const aiPrefs = () => { db.ai ??= { replies: true }; return normalizePrefs(db.ai); };
const LANG_RE = /^[a-z]{2,3}$/;
const translating = (peer) => translatingIn(aiPrefs(), peer);
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
// What people wrote (messages, names, files, polls) is never run through the interface
// translator (@infinitum/i18n); only the app's own wording is.
const USER_TEXT = /(^|\s)(msg-text|quote-text|quote-from|contact-name|preview|pin-text|file-name|poll-label|sp-author|st-name|spoiler|bot-about|sp-ad-title|ev-title|ev-place|ev-note)(\s|$)/;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (cls && USER_TEXT.test(cls)) n.setAttribute('translate', 'no');
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
let desk = null; // desktop-class features (public/desk.js), installed before boot
let wa = null; // location, contacts, view once, mentions, stars, blocking (public/wa.js)
let statusUi = null; // status updates, broadcast lists, locked chats (public/status.js)
let extras = null; // events, stickers, Favourites (public/extras.js)
let bots = null; // bot buttons, keyboards, commands and deep links (public/bots-ui.js)
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

let spacesUi = null; // public/spaces.js, mounted with the other controls below
let onboardWait = null; // {resolve, reject} while a new device is being registered

async function handle(msg) {
  if (msg.ref && pending.has(msg.ref)) {
    const p = pending.get(msg.ref); pending.delete(msg.ref);
    return msg.type === 'error' ? p.reject(new Error(msg.error)) : p.resolve(msg);
  }
  if (spacesUi?.onRelay(msg)) return; // channels, large groups, plans, sponsored posts
  switch (msg.type) {
    case 'hello':
      hello = msg;
      if (identity) register();
      return;
    case 'registered':
      registered = true;
      if (isDeliveryKey(msg.deliveryKey)) db.deliveryKey = msg.deliveryKey;
      setConn('connected', true);
      bots?.onSignedIn();
      phone ??= createPhone({ request, inCall: () => Boolean(calls?.active), vault: { get: () => (db.burners ??= { records: [], byPeer: {} }), save: () => persist() } });
      phone.refresh();
      request({ type: 'number_status' }).then(onNumberStatus).catch(() => {});
      await adoptOwnList(msg.list);
      if (onboardWait) { onboardWait.resolve(); onboardWait = null; }
      flushOutbox();
      calls?.reconnected();
      spacesUi?.connected();
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
    case 'number_status':
    case 'number_linked':
      return onNumberStatus(msg);
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

/** Digits, spaces and phone punctuation, 7+ digits, no letters: a phone number, not a handle. */
const looksLikeNumber = (s) => /^[+\d][\d\s().-]*$/.test(String(s).trim()) && String(s).replace(/\D/g, '').length >= 7;
const defaultCountry = () => numberStatus?.countries?.[0] || '+1';

async function addContact(raw) {
  if (looksLikeNumber(raw)) {
    const n = toE164(raw, defaultCountry());
    const found = n && await lookupNumber(n);
    if (!found) throw new Error(`No one on FabriC++ is findable at ${formatNumber(n || raw)}.`);
    return addContact(found);
  }
  const h = normalizeHandle(raw);
  if (!isValidHandle(h)) throw new Error('Use letters, numbers or _ (2–24), like +alex.veil');
  if (h === db.handle) throw new Error("That's you.");
  if (!db.contacts[h]?.list) await refreshContact(h, { force: true }).catch(() => { throw new Error(`${h} is not on FabriC++ yet.`); });
  openThread(h);
}

// ---------- chats: one-to-one and groups ----------
const groupsOf = () => (db.groups ??= {});
const prefsOf = () => (db.chatPrefs ??= {});
const userPrefs = () => (db.prefs ??= { receipts: true, typing: true, notify: false });
const groupFor = (key) => (isGroupKey(key) ? groupsOf()[groupIdOf(key)] || null : null);
const chatName = (key) => (key === SAVED ? 'Saved messages' : groupFor(key)?.name || key);
const inGroup = (g) => Boolean(g && !g.left && g.members.includes(db.handle));
/** Handles a message in this chat goes to (never me). */
function recipientsOf(key) {
  const g = groupFor(key);
  if (g) return inGroup(g) ? g.members.filter((h) => h !== db.handle) : [];
  return isGroupKey(key) ? [] : [key];
}
/** Fetch device lists for people I only know from a group; they stay out of the chat list. */
async function ensureContacts(handles) {
  for (const h of handles) {
    if (h === db.handle || db.contacts[h]?.list) continue;
    const known = Boolean(db.contacts[h]);
    try {
      await refreshContact(h, { force: true });
      if (!known && db.contacts[h]) db.contacts[h].viaGroup = true;
    } catch { /* not reachable now; a later message retries */ }
  }
}
/** Every device a payload for this chat goes to, plus my own other devices (with selfPayload). */
function deviceTargets(key, payload, selfPayload, only = null) {
  const targets = [];
  for (const h of recipientsOf(key)) {
    if (only && h !== only) continue;
    const c = db.contacts[h];
    if (!c?.list || c.pendingAccount) continue;
    for (const d of c.list.payload.devices) targets.push({ addr: deviceAddr(h, d.id), payload, name: `${h} · ${d.name}` });
  }
  if (selfPayload) {
    for (const d of myDevices()) if (d.id !== db.deviceId) targets.push({ addr: deviceAddr(db.handle, d.id), payload: selfPayload, name: d.name });
  }
  return targets;
}

/**
 * Anything that isn't a message — edits, reactions, receipts, typing, group changes — encrypted to
 * the chat's devices (and my other devices with `self`). With `outbox`, copies wait in
 * db.actionsOut until the relay takes them; typing signals don't wait.
 */
async function sendControl(key, payload, { outbox = true, self = true, only = null } = {}) {
  const gid = groupIdOf(key);
  const p = gid ? { ...payload, gid } : payload;
  const targets = deviceTargets(key, p, self ? { ...p, peer: key } : null, only);
  if (!targets.length) return;
  const id = newMessageId();
  const ts = Date.now();
  const out = [];
  for (const t of targets) {
    try { out.push(await sessions.encrypt(t.addr, t.payload, { id, ts })); } catch { /* that device misses this one */ }
  }
  if (outbox) (db.actionsOut ??= []).push(...out);
  try { await persist(); } catch { return; }
  for (const env of out) deliver(env);
}

// ---------- messaging ----------
async function sendText(text, tr = null, extra = null, to = active) {
  if (extra === null && to === active && composeCtx?.mode === 'reply') { extra = { reply: composeCtx.quote }; clearComposeCtx(); }
  extra ||= {};
  if (to === SAVED) return saveNote(text, extra);
  const g = groupFor(to);
  if (isGroupKey(to) && !inGroup(g)) return;
  if (!g && db.blocked?.[to]) { toast('Unblock this contact to message them.'); return; }
  const media = extra.media ? mediaOf({ media: extra.media }) : null;
  const wire = {
    ...(extra.reply ? { reply: extra.reply } : {}), ...(extra.fwd ? { fwd: true } : {}),
    ...(media ? { media: { type: media.type, mime: media.mime, name: media.name, data: media.data, ...(media.w ? { w: media.w, h: media.h } : {}), ...(media.dur ? { dur: media.dur } : {}) } } : {}),
    ...(g ? { group: { id: g.id, name: g.name, members: g.members } } : {}),
    ...(extra.silent ? { silent: true } : {}),
    ...(extra.poll ? { poll: extra.poll } : {}),
    ...(extra.event ? { event: extra.event } : {}),
    ...(extra.sticker && media?.type === 'image' ? { sticker: true } : {}),
    ...(extra.loc ? { loc: extra.loc } : {}), ...(extra.card ? { card: extra.card } : {}),
    ...(extra.once && media?.type === 'image' ? { once: true } : {}),
    ...(isTtl(prefsOf()[to]?.ttl) ? { ttl: prefsOf()[to].ttl } : {}),
  };
  if (g) await ensureContacts(g.members);
  else {
    try { await refreshContact(to); } catch { /* offline: use the cached device list */ }
    const c = db.contacts[to];
    if (!c?.list || c.pendingAccount) return;
  }
  const id = newMessageId();
  const ts = Date.now();
  const out = [];
  const skipped = [];
  // every device of the contact, then my own other devices (so they show what I sent)
  const targets = deviceTargets(to,
    { kind: 'text', text, ...trFields(tr), ...wire, dk: db.deliveryKey || undefined },
    // a view-once photo isn't copied to my other devices: they show that one went
    wire.once ? { kind: 'sync', peer: to, text: text || 'View-once photo', ...trFields(tr), ...wire, media: undefined } : { kind: 'sync', peer: to, text, ...trFields(tr), ...wire });
  for (const t of targets) {
    try {
      const env = await sessions.encrypt(t.addr, t.payload, { id, ts });
      if (env.to !== db.handle && !out.some((e) => e.to !== db.handle)) env.count = true; // count once
      out.push(env);
    } catch (err) {
      skipped.push(`${t.name}: ${err.message}`);
    }
  }
  const msg = { id, from: db.handle, text, ts, status: registered ? 'sending' : 'offline', out, ...(tr ? { sentTr: tr } : {}), ...extrasOf(wire), ...waExtrasOf(wire), ...(media ? { media } : {}) };
  if (msg.once) delete msg.media.data; // the sender doesn't keep a view-once photo either
  if (!out.some((e) => e.to !== db.handle)) { msg.status = 'failed: ' + (skipped[0] || 'no devices'); delete msg.out; }
  (db.threads[to] ??= []).push(msg);
  if (prefsOf()[to]?.archived && !prefsOf()[to]?.muted) delete prefsOf()[to].archived; // sending brings a chat back
  if (to === active) { renderMessages(); renderPqBadge(); }
  renderContacts();
  // The ratchets have advanced: that must be on disk before any ciphertext leaves, or a crash
  // could make this device reuse a message key for a different message.
  try { await persist(); } catch {
    msg.status = 'failed: could not save'; delete msg.out; renderMessages();
    return;
  }
  for (const env of out) deliver(env);
  shareProfile(to).catch(() => {}); // they get my photo once per version, after the first message
}

// ---------- profile photo: shared end-to-end encrypted with the people I chat with ----------
const PHOTO_SKIP = (k) => !k || k === SAVED || isBotHandle(k) || k === '@scalvs.veil';

/** A `profile` payload: a contact's new photo, or (from my other device) my own. */
function onProfile(payload, c) {
  const inc = avatarOf(payload);
  if (!inc) return;
  if (!c) { // my other device changed my photo, or sent it to one of my chats
    if (isNewer(db.profile, inc)) { db.profile = inc; db.profileSent = {}; }
    const k = payload.gid !== undefined ? groupKey(String(payload.gid)) : payload.peer;
    if (k && db.profile?.v === inc.v) (db.profileSent ??= {})[k] = inc.v;
  } else {
    if (!isNewer(c.avatar, inc)) return;
    c.avatar = inc;
  }
  persist().catch(() => {});
  refreshAvatars();
}

function refreshAvatars() {
  renderContacts();
  if (active) renderThreadHead();
  if (currentTab === 'settings') renderSettings();
}

/** Send my current photo (or its removal) to one chat, once per version. */
async function shareProfile(key) {
  if (PHOTO_SKIP(key) || db.blocked?.[key] || !needsProfile(db.profile, db.profileSent, key)) return;
  if (isGroupKey(key) ? !inGroup(groupFor(key)) : !db.contacts[key]?.list) return;
  const v = db.profile.v;
  await sendControl(key, profilePayload(db.profile));
  (db.profileSent ??= {})[key] = v;
  await persist();
}

/** After a change: the chats I've used most recently get it now; the rest with my next message. */
async function broadcastProfile() {
  const keys = Object.keys(db.threads)
    .filter((k) => !PHOTO_SKIP(k) && (isGroupKey(k) ? inGroup(groupFor(k)) : db.contacts[k] && !db.contacts[k].viaGroup))
    .sort((a, b) => lastTs(b) - lastTs(a))
    .slice(0, 100);
  for (const k of keys) {
    if (db.profile?.v === undefined) return;
    try { await shareProfile(k); } catch { /* next message retries */ }
  }
}

async function setMyPhoto(data) {
  db.profile = { data, v: Date.now(), ...(db.profile?.about ? { about: db.profile.about } : {}) };
  db.profileSent = {};
  await persist();
  refreshAvatars();
  toast(data ? 'Profile photo updated' : 'Profile photo removed');
  broadcastProfile();
}

/** Crop a square (centre, zoomed by `zoom`, nudged by dx/dy in -1..1) and shrink it to AVATAR_PX. */
async function setMyAbout(about) {
  db.profile = { data: db.profile?.data || null, v: Date.now(), ...(about ? { about } : {}) };
  db.profileSent = {};
  await persist();
  toast(about ? 'About updated' : 'About removed');
  broadcastProfile();
}

async function squarePhoto(bitmap, { zoom = 1, dx = 0, dy = 0 } = {}) {
  const side = Math.min(bitmap.width, bitmap.height) / zoom;
  const sx = (bitmap.width - side) / 2 * (1 + dx);
  const sy = (bitmap.height - side) / 2 * (1 + dy);
  const cv = document.createElement('canvas');
  cv.width = cv.height = AVATAR_PX;
  const g = cv.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  let q = 0.85, out = cv.toDataURL('image/jpeg', q);
  while (out.length > 60 * 1024 && q > 0.4) { q -= 0.15; out = cv.toDataURL('image/jpeg', q); }
  return out;
}

/** An image to draw: an ImageBitmap where the browser can, else a decoded <img> (some Android WebViews). */
async function decodeImage(file) {
  try { return await createImageBitmap(file); } catch (e) { console.warn('createImageBitmap failed', e); }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const out = document.createElement('canvas'); // a canvas copy, so the blob URL can go now
    out.width = img.naturalWidth; out.height = img.naturalHeight;
    out.getContext('2d').drawImage(img, 0, 0);
    return out;
  } catch (e) { console.warn('image decode failed', e); return null; } finally { URL.revokeObjectURL(url); }
}

let photoBitmap = null;
const photoCrop = { zoom: 1, dx: 0, dy: 0 };
async function renderPhotoPreview() {
  $('photo-preview').src = await squarePhoto(photoBitmap, photoCrop);
}
async function openPhotoDialog(file) {
  photoBitmap = await decodeImage(file);
  if (!photoBitmap) { toast("That file isn't an image this device can read"); return; }
  Object.assign(photoCrop, { zoom: 1, dx: 0, dy: 0 });
  $('photo-zoom').value = '1';
  await renderPhotoPreview();
  $('photo-dialog').showModal();
}

/** Saved messages: notes to myself, kept on this device (and in backups and linked-device copies). */
async function saveNote(text, extra) {
  const media = extra.media ? mediaOf({ media: extra.media }) : null;
  const msg = { id: newMessageId(), from: db.handle, text, ts: Date.now(), status: 'saved', ...(extra.reply ? { reply: extra.reply } : {}), ...(extra.fwd ? { forwarded: true } : {}), ...(media ? { media } : {}) };
  (db.threads[SAVED] ??= []).push(msg);
  if (active === SAVED) renderMessages();
  renderContacts();
  await persist();
}

/**
 * Edit, delete or react: applied here at once, then sent to every device of the contact and to my
 * own other devices. Copies wait in db.actionsOut until the relay takes them, like messages do.
 */
async function sendAction(to, act, target, fields = {}) {
  const payload = actionPayload(act, target, fields);
  if (!applyAction(db.threads[to] || [], db.handle, payload)) return;
  if (to === active) renderMessages();
  renderContacts();
  if (to === SAVED) { await persist(); return; }
  await sendControl(to, payload);
}

/** Tell senders I've read their messages in this chat (and my other devices, so they clear too). */
async function sendReceipts(key) {
  const t = db.threads[key];
  if (!t || document.hidden) return;
  const pending = unreadFrom(t, db.handle);
  if (!pending.length) return;
  const recent = Date.now() - 7 * 864e5;
  for (const m of pending) m.receiptSent = true;
  persist();
  if (userPrefs().receipts === false) return;
  const bySender = {};
  for (const m of pending) if (m.ts > recent && isValidHandle(m.from)) (bySender[m.from] ??= []).push(m.id);
  for (const [h, ids] of Object.entries(bySender)) {
    await sendControl(key, receiptPayload(ids), { only: h }).catch(() => {});
  }
}

// typing: sent at most every few seconds while composing, shown for a few seconds
const typingNow = {};
let lastTypingSent = 0;
function renderTyping() {
  const t = active && typingNow[active];
  const on = Boolean(t && t.until > Date.now());
  const box = $('typing');
  if (!box) return;
  box.textContent = on ? (isGroupKey(active) ? `${t.who} is typing…` : 'typing…') : '';
  box.classList.toggle('hidden', !on);
  $('peer-status')?.classList.toggle('hidden', on);
}
function noteTyping() {
  if (!active || composeCtx?.mode === 'edit' || userPrefs().typing === false || !$('text').value.trim()) return;
  // only once we've heard from them, so a typing signal never sets up a new session by itself
  if (!(db.threads[active] || []).some((m) => m.from !== db.handle && m.from !== '@system')) return;
  const now = Date.now();
  if (now - lastTypingSent < TYPING_SEND_EVERY) return;
  lastTypingSent = now;
  sendControl(active, { kind: 'typing' }, { outbox: false, self: false }).catch(() => {});
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
  const newSender = !fromSelf && !db.contacts[env.from];
  if (newSender) {
    try { await refreshContact(env.from, { force: true }); } catch { return; } // someone new
    db.contacts[env.from].viaGroup = true; // out of the chat list until they write to me directly
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
  if (!fromSelf && dropFromBlocked(db, env.from, payload)) return; // blocked: decrypted (keeps the session in step), then dropped
  if (payload.kind === 'call') {
    if (!fromSelf) calls?.onSignal(env, payload);
    return;
  }
  if (payload.kind === 'space_key') { // a large group's or channel's new key, from an admin
    spacesUi?.onKey(payload, fromSelf ? db.handle : env.from);
    return;
  }
  if (payload.kind === 'profile') { onProfile(payload, fromSelf ? null : c); return; }
  if (payload.kind === 'status' || payload.kind === 'status_seen') { statusUi?.onPayload(payload, fromSelf ? null : env.from, env.ts); return; }
  // which chat a control payload belongs to: a group I'm in (by gid), else the contact
  const keyOf = () => {
    if (payload.gid !== undefined) {
      const k = groupKey(String(payload.gid));
      const g = groupFor(k);
      return g && (fromSelf || g.members.includes(env.from)) ? k : null;
    }
    const k = fromSelf ? payload.peer : env.from;
    if (isGroupKey(k)) return fromSelf && groupFor(k) ? k : null;
    return isValidHandle(k) ? k : null;
  };
  if (payload.kind === 'typing') {
    if (fromSelf || !freshTyping(env.ts)) return;
    const k = keyOf();
    if (!k) return;
    typingNow[k] = { who: env.from, until: Date.now() + TYPING_SHOW_FOR };
    renderTyping();
    setTimeout(renderTyping, TYPING_SHOW_FOR + 50);
    return;
  }
  if (payload.kind === 'receipt') {
    const k = keyOf();
    const t = k && db.threads[k];
    if (!t || !Array.isArray(payload.ids)) return;
    const ids = new Set(payload.ids);
    if (fromSelf) { // read on another of my devices
      for (const m of t) if (ids.has(m.id)) m.receiptSent = true;
      if (!unreadFrom(t, db.handle).length) delete db.unread[k];
    } else if (groupFor(k)) {
      const g = groupFor(k);
      for (const m of t) {
        if (m.from !== db.handle || !ids.has(m.id)) continue;
        (m.readBy ??= {})[env.from] = env.ts;
        if (!m.read && Object.keys(m.readBy).length >= g.members.length - 1) m.read = env.ts;
      }
    } else applyReceipt(t, db.handle, payload, env.ts);
    persist(); renderContacts();
    if (k === active) renderMessages();
    return;
  }
  if (payload.kind === 'group') {
    const inc = groupOf(payload);
    const op = ['create', 'rename', 'add', 'leave'].includes(payload.op) ? payload.op : null;
    if (!inc || !op) return;
    const mine = groupsOf()[inc.id];
    const next = mergeGroup(mine, inc, env.from, db.handle, op === 'create' ? 'msg' : op);
    if (!next) return;
    const k = groupKey(inc.id);
    groupsOf()[inc.id] = { ...next, created: mine?.created || env.ts, ...(fromSelf && op === 'leave' ? { left: true } : {}) };
    db.threads[k] ??= [];
    const who = fromSelf ? 'You' : env.from;
    const line = op === 'create' ? (mine ? null : fromSelf ? `You created “${next.name}”` : `${who} added you to “${next.name}”`)
      : op === 'rename' ? `${who} renamed the group to “${next.name}”`
        : op === 'add' ? `${who} added ${next.members.filter((h) => !mine?.members.includes(h) && h !== db.handle).join(', ') || 'you'}`
          : `${who} left`;
    if (line) systemLine(k, line);
    persist(); renderContacts();
    if (k === active) { renderMessages(); renderThreadHead(); }
    ensureContacts(next.members).then(() => persist());
    return;
  }
  if (payload.kind === 'chat_ttl') {
    const k = keyOf();
    const ttl = payload.ttl === 0 || isTtl(payload.ttl) ? payload.ttl : null;
    if (!k || ttl === null) return;
    const p = (prefsOf()[k] ??= {});
    if ((p.ttl || 0) === ttl) return;
    if (ttl) p.ttl = ttl; else delete p.ttl;
    systemLine(k, `${fromSelf ? 'You' : env.from} ${ttl ? `set messages to disappear after ${ttlLabel(ttl)}` : 'turned off disappearing messages'}`);
    persist(); renderContacts();
    if (k === active) { renderMessages(); desk?.renderThreadExtras(); }
    return;
  }
  if (payload.kind === 'bot_answer') { if (!fromSelf) bots?.onAnswer(env.from, payload); return; }
  if (payload.kind === 'action') {
    const peer = keyOf();
    if (!peer || !db.threads[peer]) return;
    const m = applyAction(db.threads[peer], fromSelf ? db.handle : env.from, payload, env.ts);
    if (!m) return;
    if (payload.act === 'edit') bots?.applyEditMarkup(m, payload);
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
    if (payload.kind !== 'sync') return;
    const g = groupOf(payload);
    if (g) {
      if (!groupsOf()[g.id]) groupsOf()[g.id] = { ...g, created: env.ts };
      peer = groupKey(g.id);
    } else {
      if (!isValidHandle(payload.peer)) return;
      peer = payload.peer;
      if (!db.contacts[peer]) await refreshContact(peer, { force: true }).catch(() => {});
    }
    entry = { id: env.id, from: db.handle, text: String(payload.text ?? ''), ts: env.ts, status: 'sent from another device', ...extrasOf(payload), ...waExtrasOf(payload) };
    const st = sentTrOf(payload);
    if (st) entry.sentTr = st;
  } else {
    if (payload.kind !== 'text') return;
    const g = groupOf(payload);
    if (g) {
      const mine = groupsOf()[g.id];
      if (mine && !inGroup(mine)) return; // I left
      const next = mergeGroup(mine, g, env.from, db.handle, 'msg');
      if (!next) return;
      if (!mine) {
        groupsOf()[g.id] = { ...next, created: env.ts };
        db.threads[groupKey(g.id)] ??= [];
        systemLine(groupKey(g.id), `${env.from} added you to “${next.name}”`);
        ensureContacts(next.members).then(() => persist());
      }
      peer = groupKey(g.id);
    } else peer = env.from;
    entry = { id: env.id, from: env.from, text: String(payload.text ?? ''), ts: env.ts, ...extrasOf(payload), ...waExtrasOf(payload) };
    const st = sentTrOf(payload);
    if (st) entry.sentTr = st;
  }
  const media = mediaOf(payload);
  if (media) entry.media = media;
  const markup = !fromSelf && bots?.markupFor(env.from, payload);
  if (markup) entry.markup = markup;
  if (!entry.text && !entry.media) return;
  const thread = (db.threads[peer] ??= []);
  if (thread.some((m) => m.id === env.id)) return;
  thread.push(entry);
  thread.sort((a, b) => a.ts - b.ts);
  if (typingNow[peer]?.who === env.from) { delete typingNow[peer]; renderTyping(); }
  if (!fromSelf && db.contacts[env.from]?.viaGroup && peer === env.from) delete db.contacts[env.from].viaGroup;
  if (!fromSelf && (peer !== active || document.hidden)) {
    db.unread[peer] = (db.unread[peer] || 0) + 1;
    notifyIncoming(peer, entry);
  }
  persist();
  renderContacts();
  if (peer === active) { renderMessages(); if (!fromSelf) sendReceipts(peer); }
  if (!fromSelf && translating(peer)) translateEntry(peer, entry);
}

// ---------- rendering ----------
let showArchived = false;
/** Every chat: contacts I talk to (not people I only know from a group) and groups. */
function chatKeys() {
  const keys = Object.keys(db.contacts).filter((h) => !db.contacts[h].viaGroup || db.threads[h]?.some((m) => m.from !== '@system'));
  for (const id of Object.keys(groupsOf())) keys.push(groupKey(id));
  if (db.threads[SAVED]?.length || prefsOf()[SAVED]?.pinned) keys.push(SAVED);
  return keys;
}
const shortName = (h) => h.replace(/^@/, '').replace(/\.veil$/, '');
function previewOf(key, last) {
  const draft = desk?.draftOf(key);
  if (draft) return 'Draft: ' + plainText(draft).replace(/\s+/g, ' ');
  if (!last) return isGroupKey(key) ? (db.threads[key]?.at(-1)?.text || 'No messages yet') : 'No messages yet';
  const who = last.from === db.handle ? 'You: ' : isGroupKey(key) ? `${shortName(last.from)}: ` : '';
  if (last.deleted) return who + 'Message deleted';
  const text = last.from !== db.handle && !last.sentTr && last.tr?.text && translating(key) ? last.tr.text : last.text; // as shown in the chat
  if (last.once) return who + 'View-once photo';
  if (last.loc) return who + '📍 ' + (last.loc.label || 'Location');
  if (last.card) return who + '👤 Contact';
  if (last.sticker) return who + 'Sticker';
  if (last.event) return who + '📅 ' + last.event.title + (last.evCancelled ? ' (cancelled)' : '');
  return who + mediaLabel(last.media, plainText(text));
}
function renderContacts() {
  const ul = $('contacts');
  ul.replaceChildren();
  const q = searchQuery();
  const everything = statusUi ? statusUi.filterChats(chatKeys()) : chatKeys();
  desk?.renderFolders(everything.filter((k) => !prefsOf()[k]?.archived));
  const all = everything.filter((k) => (!q || chatName(k).toLowerCase().includes(q) || k.toLowerCase().includes(q)) && (q || showArchived || !desk || desk.matches(k)));
  const archivedCount = orderChats(all, prefsOf(), lastTs, { archived: true }).length;
  const handles = orderChats(all, prefsOf(), lastTs, { archived: showArchived });
  statusUi?.renderTop(ul, { searching: Boolean(q), archived: showArchived });
  if (showArchived || archivedCount) {
    const row = el('li', 'archived-row');
    row.append(el('span', '', showArchived ? '← Back to chats' : `Archived · ${archivedCount}`));
    row.onclick = () => { showArchived = !showArchived; renderContacts(); };
    ul.append(row);
  }
  let totalUnread = 0;
  for (const h of handles) {
    const p = prefsOf()[h] || {};
    const li = el('li', h === active ? 'active' : '');
    li.dataset.key = h;
    const left = el('div', 'contact-main');
    const top = el('div', 'contact-top');
    const name = el('div', 'contact-name', chatName(h));
    if (db.contacts[h]?.verified) name.append(' ', el('span', 'verified', '✓'));
    if (p.muted) name.append(' ', el('span', 'chat-flag', '🔕'));
    if (p.pinned) name.append(' ', el('span', 'chat-flag', '📌'));
    const last = db.threads[h]?.filter((m) => m.from !== '@system').at(-1);
    const lastAny = db.threads[h]?.at(-1);
    top.append(name, el('span', 'contact-time', lastAny ? shortWhen(lastAny.ts) : ''));
    const bottom = el('div', 'contact-bottom');
    const typing = typingNow[h]?.until > Date.now();
    bottom.append(el('div', 'preview' + (typing ? ' typing' : desk?.draftOf(h) ? ' draft' : ''), typing ? (isGroupKey(h) ? `${shortName(typingNow[h].who)} is typing…` : 'typing…') : previewOf(h, last)));
    if (db.unread[h]) bottom.append(el('span', 'badge' + (p.muted ? ' muted' : ''), String(db.unread[h])));
    if (!p.muted) totalUnread += db.unread[h] || 0;
    left.append(top, bottom);
    li.append(chatAvatar(h), left);
    li.onclick = () => openThread(h);
    bindChatMenu(li, h);
    ul.append(li);
  }
  if (db.handle) document.title = `${totalUnread ? `(${totalUnread}) ` : ''}FabriC++ · ${db.handle}`;
  if (!handles.length && !showArchived) {
    const hint = q
      ? (isValidHandle(normalizeHandle(q)) ? `No chats match. Press + to start a chat with ${normalizeHandle(q)}.` : 'No chats match.')
      : 'No chats yet. Type an address like +alex above and press +.';
    ul.append(el('li', 'contacts-empty', hint));
  }
  spacesUi?.chatListAd(ul); // free plan: one sponsored row, labelled
  renderSearchHits(q);
}
const searchQuery = () => ($('add-handle')?.value || '').trim().toLowerCase().replace(/^[+]/, '@').replace(/^@$/, '');

/** Messages matching the search box, across every chat on this device. */
function renderSearchHits(q) {
  const box = $('search-hits');
  box.replaceChildren();
  const hits = [];
  if (q.length >= 2) {
    for (const [h, list] of Object.entries(db.threads)) {
      if (statusUi?.isLocked(h)) continue; // a locked chat's messages stay hidden until it's opened with the code
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
  const photo = photoOf(h);
  if (photo) {
    const img = new Image();
    img.alt = ''; img.decoding = 'async'; img.src = photo;
    a.classList.add('has-photo');
    a.replaceChildren(img);
  }
  return a;
}
/** A profile photo (data URL) for this handle, if they shared one with me. */
function photoOf(h) {
  if (!db) return null;
  return (h === db.handle ? db.profile?.data : db.contacts?.[h]?.avatar?.data) || null;
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
const lastTs = (h) => db.threads[h]?.at(-1)?.ts || groupFor(h)?.created || db.contacts[h]?.addedAt || 0;
function chatAvatar(key, cls = 'avatar') {
  if (key === SAVED) { const a = el('div', cls + ' saved'); a.setAttribute('aria-hidden', 'true'); a.append(svgIcon('M6 3h12v18l-6-4-6 4z')); return a; }
  const g = groupFor(key);
  if (!g) return avatarEl(key, cls);
  const a = avatarEl('#' + g.name, cls + ' group');
  a.textContent = (g.name.trim()[0] || '#').toUpperCase();
  return a;
}

function renderMessages() {
  if (!active) return;
  const ol = $('messages');
  ol.replaceChildren();
  bots?.renderThread(active); // bot notice and Start, reply keyboard, / commands
  const q = threadQuery;
  let lastDay = '', hits = 0, lastHit = null;
  for (const m of db.threads[active] || []) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { ol.append(el('li', 'day-sep', dayLabel(m.ts))); lastDay = day; }
    if (m.from === '@system') { ol.append(el('li', 'sysline', m.text)); continue; }
    const mine = m.from === db.handle;
    const li = el('li', 'msg' + (mine ? ' mine' : '') + (m.status?.startsWith('failed') ? ' failed' : '') + (m.deleted ? ' deleted' : '') + (m.sticker && m.media && !m.deleted ? ' sticker-msg' : ''));
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
    if (!mine && isGroupKey(active)) {
      const who = el('div', 'msg-from', m.from);
      who.style.color = avatarColor(m.from);
      li.append(who);
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
    if (m.media) li.append(m.once && wa ? wa.onceEl(m) : mediaEl(m));
    const translated = !mine && !m.sentTr && m.tr?.text && translating(active); // shown translated; the original opens underneath
    const flipped = m.sentTr && showOriginal.has(m.id); // a message sent translated, shown as written
    const shown = flipped ? m.sentTr.text : translated ? m.tr.text : m.text;
    if (q && shown.toLowerCase().includes(q)) { { const t = el('span', 'msg-text'); t.append(...highlighted(shown, q, 'msg-text').childNodes); li.append(t); } li.classList.add('hit'); hits++; lastHit = li; }
    else if (wa?.renderBody(li, m)) { /* a location or contact card */ }
    else if (m.event && extras) extras.renderEvent(li, m);
    else if (m.poll && desk) desk.renderPoll(li, m);
    else if (m.sticker && m.media) { /* the sticker itself is the message */ }
    else if (desk) { const t = el('span', 'msg-text'); desk.formatInto(t, shown); wa?.markMentions(t); li.append(t); }
    else li.append(el('span', 'msg-text', shown));
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const ed = m.edited ? 'edited · ' : '';
    const seen = mine && m.read && userPrefs().receipts !== false;
    const meta = el('div', 'meta', mine ? `${ed}${time} · ${seen ? 'read' : m.status || ''}${m.sealed ? ' · sealed' : ''}${m.silent ? ' · no sound' : ''}` : ed + time);
    if (m.pinned) meta.prepend(el('span', 'pin-mark', 'pinned · '));
    if (m.starred) meta.prepend(el('span', 'star-mark', '★ '));
    if (m.ttl) meta.title = `Disappears ${new Date(m.ts + m.ttl * 1000).toLocaleString()}`;
    if (mine) meta.prepend(el('span', 'ticks' + (seen ? ' read' : ''), seen || /^(delivered|queued)/.test(m.status || '') ? '✓✓ ' : /^sending|^offline/.test(m.status || '') ? '○ ' : /^failed/.test(m.status || '') ? '! ' : '✓ '));
    li.append(meta);
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
    } else if (translated) {
      li.append(trNoteEl(m.tr, m.text, `m:${m.id}`));
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
    bots?.decorate(li, m, active);
    ol.append(li);
  }
  if (q) {
    $('thread-search-count').textContent = hits ? `${hits} found` : 'None found';
    lastHit?.scrollIntoView({ block: 'center' });
  } else ol.scrollTop = ol.scrollHeight;
  renderTranslateToggle();
  renderTranslateOut();
  suggestReplies();
  desk?.renderPinBar();
}

// ---------- on-device AI: translating what I send ----------
/** The "Send in" menu: as written, or translated into a language (their language first when known). */
function renderTranslateOut() {
  const sel = $('translate-out');
  if (!active) return;
  const theirs = theirLanguage(db.threads[active], db.handle, ai.target); // groups too
  const langs = [...new Set([...(theirs && TRANSLATION_LANGS.includes(theirs) ? [theirs] : []), ...TRANSLATION_LANGS])].filter((l) => l !== ai.target || l === aiPrefs().out[active]);
  const want = aiPrefs().out[active] || '';
  const key = `${active}|${langs.join(',')}|${want}`;
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  sel.replaceChildren(new Option('As written', ''));
  for (const l of langs) sel.append(new Option(`In ${languageName(l)}${l === theirs ? ' (theirs)' : ''}`, l));
  sel.value = want;
  updateTrBadge();
}
function updateTrBadge() {
  const v = $('translate-out').value;
  $('tr-code').textContent = v.toUpperCase();
  $('tr-code').classList.toggle('hidden', !v);
  $('translate-out').closest('.tr-pick').classList.toggle('on', Boolean(v));
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
let aiAsk = null; // { peer, from }: the one-time "keep translating automatically?" question
let replyState = { key: null, list: [] };

const openOriginals = new Set(); // "m:<id>" / "p:<sid>:<seq>": originals shown under translations (this session only)

/**
 * "Translated from Spanish · Show original", and the original underneath once opened.
 * Used for chat messages and for posts in channels and large groups.
 */
function trNoteEl(tr, original, key, rerender = renderMessages) {
  const open = openOriginals.has(key);
  const n = noteFor(tr, { open, name: (c) => languageName(c) });
  const wrap = el('div', 'tr-wrap');
  const note = el('div', 'tr-note', `${n.label} · `);
  const b = el('button', 'link tr-toggle', n.action);
  b.type = 'button';
  b.setAttribute('aria-expanded', String(open));
  b.onclick = (e) => { e.stopPropagation(); if (open) openOriginals.delete(key); else openOriginals.add(key); rerender(); };
  note.append(b);
  wrap.append(note);
  if (open) {
    const o = el('div', 'tr-original', original);
    o.lang = tr.from;
    wrap.append(o);
  }
  return wrap;
}

function renderTranslateToggle() {
  const b = $('translate-toggle');
  const on = active && translating(active);
  b.setAttribute('aria-pressed', String(Boolean(on)));
  b.textContent = on ? 'Translating' : 'Translate';
  b.title = on ? 'Turn off automatic translation in this chat' : 'Translate incoming messages in this chat, on this device';
  const box = $('ai-needs');
  if (aiAsk && aiAsk.peer === active) {
    // asked once: the first time something is actually translated
    box.replaceChildren(el('span', '', `Translated from ${languageName(aiAsk.from)} into ${languageName(ai.target)} on this device. Messages never leave it for translation. Keep translating automatically?`));
    const keep = el('button', 'ghost', 'Keep translating');
    keep.type = 'button';
    keep.onclick = () => { setAuto(aiPrefs(), true); aiAsk = null; persist(); renderTranslateToggle(); };
    const off = el('button', 'ghost', 'Turn off');
    off.type = 'button';
    off.onclick = () => { setAuto(aiPrefs(), false); aiAsk = null; persist(); renderMessages(); spacesUi?.retranslate?.(); };
    box.append(keep, off);
    box.classList.remove('hidden');
  } else if (aiNeeds && aiNeeds.peer === active) {
    box.replaceChildren(el('span', '', `Translating ${languageName(aiNeeds.from)} needs a one-time download of the on-device translation model${aiNeeds.mb ? ` (about ${aiNeeds.mb} MB)` : ''}. It runs on this device; your messages are never sent anywhere to be translated.`));
    const btn = el('button', 'ghost', 'Download');
    btn.type = 'button';
    btn.onclick = () => downloadTranslator(aiNeeds.peer, aiNeeds.from, btn);
    const no = el('button', 'ghost', 'Not now');
    no.type = 'button';
    no.onclick = () => { aiNeeds = null; renderTranslateToggle(); };
    box.append(btn, no);
    box.classList.remove('hidden');
  } else box.classList.add('hidden');
  renderReplyOffer();
}

/** The first translation on a new install asks, once, whether to keep translating automatically. */
function noteTranslated(peer, from) {
  if (!shouldAsk(aiPrefs()) || aiAsk) return;
  aiAsk = { peer, from };
  if (peer === active) renderTranslateToggle();
}

/**
 * Translate one incoming message (chat, group chat, bot reply, edit) on this device. The result
 * is saved with the message, in the encrypted vault. Text that is already in my language is
 * marked, so it isn't detected again.
 */
async function translateEntry(peer, m, { allowDownload = false, onProgress } = {}) {
  if (m.tr || m.sentTr || m.from === db.handle || m.from === '@system' || m.deleted || !m.text?.trim()) return;
  const text = m.text;
  if (m.trSkip === textHash(text) && !allowDownload) return;
  try {
    const r = await ai.translate(text, { allowDownload, onProgress });
    if (!stillCurrent(m, text) || m.tr) return; // edited or deleted while the model ran
    if (!r) { m.trSkip = textHash(text); persist(); return; }
    if (r.needsDownload) { aiNeeds = { peer, from: r.from, mb: ai.translationMb?.(r.from) }; if (peer === active) renderTranslateToggle(); return; }
    delete m.trSkip;
    m.tr = { from: r.from, text: String(r.text).slice(0, 8000) };
    persist();
    noteTranslated(peer, r.from);
    renderContacts(); // the chat list shows the translation too
    if (peer === active) renderMessages();
  } catch (e) {
    console.warn('on-device translation failed', e);
  }
}

const trBusy = new Set();
async function translateRecent(peer, opts = {}) {
  if (trBusy.has(peer) && !opts.allowDownload) return;
  trBusy.add(peer);
  try {
    for (const m of (db.threads[peer] || []).filter((x) => x.from !== db.handle && x.from !== '@system').slice(-30)) {
      if (!translating(peer)) return;
      await translateEntry(peer, m, opts);
    }
  } finally { trBusy.delete(peer); }
}

async function downloadTranslator(peer, from, btn) {
  btn.disabled = true;
  const progress = (p) => { btn.textContent = `Downloading… ${Math.round(p * 100)}%`; };
  try {
    await translateRecent(peer, { allowDownload: true, onProgress: progress });
    aiNeeds = null;
  } catch (e) { toast(`Download failed: ${e.message}`); }
  renderTranslateToggle();
}

$('translate-toggle').onclick = () => {
  if (!active) return;
  const on = toggleChat(aiPrefs(), active);
  if (aiAsk) { if (aiPrefs().auto === undefined) aiPrefs().auto = true; aiAsk = null; } // they've chosen
  persist();
  closeThreadMenu();
  renderMessages();
  if (on) {
    translateRecent(active);
    wsSend({ type: 'feature', feature: 'translate' }); // counted only if Product research is opted in
  }
};

/** In a translated chat: offer, once, to send replies in the other person's language. */
function renderReplyOffer() {
  let box = $('tr-offer');
  const theirs = active && theirLanguage(db.threads[active], db.handle, ai.target);
  const lang = active && !aiAsk && offerReplyIn(aiPrefs(), active, theirs, { languages: TRANSLATION_LANGS }); // one question at a time
  if (!lang) { box?.remove(); return; }
  if (!box) { box = el('div', 'tr-offer'); box.id = 'tr-offer'; $('out-preview').before(box); }
  if (box.dataset.key === `${active}|${lang}`) return;
  box.dataset.key = `${active}|${lang}`;
  box.replaceChildren(el('span', '', `They write in ${languageName(lang)}. Reply in ${languageName(lang)}? You check each translation before it's sent.`));
  const yes = el('button', 'ghost', `Reply in ${languageName(lang)}`);
  yes.type = 'button';
  yes.onclick = () => { aiPrefs().out[active] = lang; persist(); box.remove(); $('translate-out').dataset.key = ''; renderTranslateOut(); };
  const no = el('button', 'ghost', 'No thanks');
  no.type = 'button';
  no.onclick = () => { aiPrefs().noOffer[active] = true; persist(); box.remove(); };
  box.append(yes, no);
}

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
  $('ai-translate-all').checked = aiPrefs().auto !== false;
  $('ai-download').classList.toggle('hidden', ![st.summarizer, st.detector, st.replies].some((x) => x.state === 'downloadable' || x.state === 'downloading'));
}

$('ai-replies').onchange = (e) => { aiPrefs().replies = e.target.checked; replyState = { key: null, list: [] }; persist(); };
$('ai-translate-all').onchange = (e) => {
  setAuto(aiPrefs(), e.target.checked);
  aiAsk = null;
  persist();
  spacesUi?.retranslate?.();
  if (active) { renderMessages(); if (translating(active)) translateRecent(active); }
};
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
  const g = groupFor(active);
  $('call-buttons').classList.toggle('hidden', Boolean(g || c?.pendingAccount || active === SAVED));
  if (g) { box.classList.add('hidden'); $('composer').classList.toggle('hidden', !inGroup(g)); return; }
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
  if (!badge) return;
  const devices = active ? db.contacts[active]?.list?.payload?.devices || [] : [];
  const kinds = devices.map((d) => sessions?.sessionKind(deviceAddr(active, d.id))).filter(Boolean);
  badge.textContent = !kinds.length ? '' : kinds.every((k) => k === 'pq') ? ' · post-quantum' : ' · classic keys (post-quantum once both apps are up to date)';
  badge.title = kinds.length && kinds.every((k) => k === 'pq')
    ? 'Session keys combine P-256 and ML-KEM-768, so recorded messages stay safe even against a future quantum computer.'
    : '';
}

async function openThread(h) {
  if (statusUi && active !== h && !(await statusUi.mayOpen(h))) return;
  closeOutPreview(); // a translation preview belongs to the chat it was made in
  if (active !== h) { desk?.saveDraft(active); if (composeCtx) clearComposeCtx(); desk?.restoreDraft(h); }
  active = h;
  delete db.unread[h];
  persist();
  $('empty').classList.add('hidden');
  $('thread').classList.remove('hidden');
  $('peer-avatar').replaceWith(Object.assign(chatAvatar(h), { id: 'peer-avatar' }));
  renderThreadHead();
  $('safety').classList.add('hidden');
  $('summary').classList.add('hidden');
  closeThreadMenu();
  closeThreadSearch();
  closeMsgMenu();
  if (composeCtx) clearComposeCtx();
  switchTab('chats');
  renderContacts(); renderMessages(); renderKeyWarning(); renderPqBadge();
  desk?.renderThreadExtras();
  sendReceipts(h);
  if (translating(h)) translateRecent(h); // anything not yet looked at, e.g. from before a model was downloaded
  if (h === SAVED) { if (!matchMedia('(pointer: coarse)').matches) $('text').focus(); return; }
  if (isGroupKey(h)) { ensureContacts(groupFor(h)?.members || []); return; }
  if (db.contacts[h]?.viaGroup) { delete db.contacts[h].viaGroup; persist(); }
  if (registered) {
    try { await refreshContact(h, { force: true }); } catch { /* offline or unknown: keep cached list */ }
    if (active === h) { renderKeyWarning(); renderMessages(); }
  }
  // On touch screens focusing would pop up the keyboard over the conversation; let the user tap.
  if (!matchMedia('(pointer: coarse)').matches) $('text').focus();
}

/** Name, sub-line and the actions that make sense for this chat. */
function renderThreadHead() {
  if (!active) return;
  const g = groupFor(active);
  $('peer').textContent = chatName(active);
  const status = $('peer-status');
  if (active === SAVED) {
    status.textContent = 'Notes to yourself · kept on this device';
  } else if (g) {
    status.textContent = inGroup(g) ? `${g.members.length} members · end-to-end encrypted` : 'You left this group';
  } else if (!status.querySelector('#pq-badge')) {
    status.replaceChildren(document.createTextNode('🔒 End-to-end encrypted'), Object.assign(el('span'), { id: 'pq-badge' }));
    renderPqBadge();
  }
  if (!g && bots?.headLabel(active)) status.textContent = `🔒 Encrypted to this ${bots.headLabel(active)}`;
  $('group-info-btn').classList.toggle('hidden', !g);
  $('show-safety').classList.toggle('hidden', Boolean(g));
  const p = prefsOf()[active] || {};
  $('mute-chat').textContent = p.muted ? `Unmute notifications (${desk?.muteLabel(active) || 'muted'})` : 'Mute notifications…';
  $('mute-chat').classList.toggle('hidden', active === SAVED);
  $('archive-chat').textContent = p.archived ? 'Unarchive chat' : 'Archive chat';
  wa?.renderThreadExtras();
  renderTyping();
}

async function showSafety() {
  if (isGroupKey(active)) return;
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
const VIEWS = ['chats', 'calls', 'phone', 'settings', 'earn', 'security', 'spaces', 'plus'];
const SUBVIEWS = { earn: 'settings', security: 'settings', spaces: 'chats', plus: 'settings' }; // opened from Settings; back returns there
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
  spacesUi?.onShow(name); // channels, large groups, Plus (public/spaces.js)
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
  if (rec) stopVoice(false);
  desk?.saveDraft(active);
  persist();
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

/** Android's Back button (the app shell asks first): close a sheet or dialog, then step back a screen.
 *  Returns false at the chat list, or during a call, so the shell sends the app to the background. */
window.fabricBack = () => {
  if (!$('call').classList.contains('hidden')) return false;
  const open = document.querySelector('dialog[open]');
  if (open) { open.close(); return true; }
  if ($('app').classList.contains('hidden')) return false;
  if (currentTab === 'chats' && !active) return false;
  goBack();
  return true;
};

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
    voice.type = 'button'; voice.title = `FabVoice ${h}`; voice.setAttribute('aria-label', voice.title);
    voice.append(svgIcon('M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z'));
    voice.onclick = (e) => { e.stopPropagation(); calls?.start(h, false); };
    const video = el('button', 'icon-btn');
    video.type = 'button'; video.title = `FabVid ${h}`; video.setAttribute('aria-label', video.title);
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
  const hasPhoto = Boolean(db.profile?.data);
  $('photo-pick').textContent = hasPhoto ? 'Change photo' : 'Add photo';
  $('photo-remove').classList.toggle('hidden', !hasPhoto);
  $('settings-handle').textContent = db.handle;
  $('settings-device').textContent = `${db.deviceName}${db.primary ? ' · primary device' : ' · linked device'}`;
  const p = userPrefs();
  $('pref-receipts').checked = p.receipts !== false;
  $('pref-typing').checked = p.typing !== false;
  $('pref-notify').checked = Boolean(p.notify) && 'Notification' in window && Notification.permission === 'granted';
  $('pref-notify').disabled = !('Notification' in window);
  let theme = 'light';
  try { theme = localStorage.getItem(THEME_KEY) || 'light'; } catch { /* */ }
  $('pref-theme').value = theme;
  desk?.renderSettings();
  wa?.renderSettings();
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
  const show = { reply: !m.deleted, copy: !m.deleted && Boolean(m.text), forward: !m.deleted && (Boolean(m.text) || Boolean(m.media?.data)), edit: mine && !m.deleted && Boolean(m.text) && !m.poll && !m.event, 'delete-all': mine && !m.deleted, 'delete-me': true };
  for (const [k, on] of Object.entries(show)) $(`msg-${k}`).classList.toggle('hidden', !on);
  desk?.onMsgMenu(m);
  wa?.onMsgMenu(m);
  extras?.onMsgMenu(m);
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
  const handles = [SAVED, ...chatKeys().filter((k) => k !== SAVED && (isGroupKey(k) ? inGroup(groupFor(k)) : db.contacts[k].list && !db.contacts[k].pendingAccount)).sort((a, b) => lastTs(b) - lastTs(a))];
  if (!handles.length) list.append(el('li', 'contacts-empty', 'No contacts yet.'));
  for (const h of handles) {
    const b = el('button', 'fwd-to');
    b.type = 'button';
    b.append(chatAvatar(h), el('span', 'contact-name', chatName(h)));
    b.onclick = async () => {
      $('fwd-dialog').close();
      await sendText(m.text, null, { fwd: true, ...(m.media?.data ? { media: m.media } : {}) }, h);
      toast(`Forwarded to ${chatName(h)}`);
    };
    const item = el('li');
    item.append(b);
    list.append(item);
  }
  $('fwd-dialog').showModal();
}

// ---------- attachments: photos, files, voice messages ----------
const blobUrls = new Map();
function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function blobUrl(m) {
  let u = blobUrls.get(m.id);
  if (!u) { u = URL.createObjectURL(new Blob([b64ToBytes(m.media.data)], { type: m.media.mime })); blobUrls.set(m.id, u); }
  return u;
}
function mediaEl(m) {
  const md = m.media;
  if (!md.data) return el('div', 'media-gone', `${mediaLabel(md)} · not on this device`);
  if (md.type === 'image') {
    const img = el('img', 'media-img');
    img.alt = 'Photo';
    img.src = `data:${md.mime};base64,${md.data}`; // mime checked against an image allowlist (shared/chat.js)
    if (md.w && md.h) { img.width = md.w; img.height = md.h; }
    img.onclick = (e) => { e.stopPropagation(); if (desk) desk.openViewer(m); else openViewer(img.src); };
    return img;
  }
  if (md.type === 'audio') {
    const box = el('div', 'media-audio');
    const a = el('audio');
    a.controls = true; a.preload = 'metadata'; a.src = blobUrl(m);
    box.append(a);
    if (md.dur) box.append(el('span', 'media-dur', fmtDuration(md.dur)));
    return box;
  }
  const link = el('a', 'media-file');
  link.href = blobUrl(m);
  link.download = md.name;
  link.append(el('span', 'file-icon', '📎'), el('span', 'file-name', md.name), el('span', 'file-size', fmtBytes(md.size)));
  link.onclick = (e) => e.stopPropagation();
  return link;
}
function openViewer(src) { $('viewer-img').src = src; $('viewer').classList.remove('hidden'); }
function closeViewer() { $('viewer').classList.add('hidden'); $('viewer-img').removeAttribute('src'); }

const blobB64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});
/** A photo, scaled and recompressed until it fits in one encrypted message. */
async function imageMedia(file) {
  if (file.size <= MAX_MEDIA_BYTES && ['image/png', 'image/gif', 'image/webp', 'image/jpeg'].includes(file.type)) {
    const bmp = await createImageBitmap(file).catch(() => null);
    return { type: 'image', mime: file.type, name: file.name, data: await blobB64(file), ...(bmp ? { w: bmp.width, h: bmp.height } : {}) };
  }
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  let q = 0.82;
  for (let i = 0; i < 10; i++) {
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= MAX_MEDIA_BYTES) return { type: 'image', mime: 'image/jpeg', name: 'photo.jpg', data: await blobB64(blob), w, h };
    if (q > 0.5) q -= 0.12; else scale *= 0.75;
  }
  throw new Error('That photo is too large to send.');
}
async function sendAttachment(file, more = {}) {
  if (!active || !file) return;
  // what goes with it is taken now: compressing a photo takes a moment, and the box may change
  const to = active;
  const extra = { ...more };
  if (composeCtx?.mode === 'reply') { extra.reply = composeCtx.quote; clearComposeCtx(); }
  const caption = composeCtx?.mode === 'edit' ? '' : $('text').value.trim();
  if (caption) { $('text').value = ''; growText(); desk?.clearDraft(to); }
  try {
    let media;
    if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') media = await imageMedia(file);
    else {
      if (file.size > MAX_MEDIA_BYTES) throw new Error(`Files up to ${fmtBytes(MAX_MEDIA_BYTES)} for now.`);
      media = { type: 'file', mime: file.type || 'application/octet-stream', name: file.name, data: await blobB64(file) };
    }
    await sendText(caption, null, { ...extra, media }, to);
  } catch (e) {
    if (caption && !$('text').value) { $('text').value = caption; growText(); } // give the caption back
    toast(e.message || 'Could not send that file.');
  }
}

const VOICE_LIMIT_S = 60; // at 16 kbit/s a minute fits in one encrypted message
let rec = null;
async function startVoice() {
  if (rec || !active) return;
  if (!window.MediaRecorder) return toast('Voice messages need a newer browser.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { return toast('Microphone not available.'); }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 16000 });
  const chunks = [];
  const to = active;
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec = { mr, stream, started: Date.now(), send: false, timer: setInterval(tickVoice, 250) };
  mr.onstop = async () => {
    const { send, started } = rec;
    clearInterval(rec.timer);
    stream.getTracks().forEach((t) => t.stop());
    rec = null;
    $('rec-bar').classList.add('hidden');
    $('composer').classList.remove('hidden');
    if (!send) return;
    const blob = new Blob(chunks, { type: (mr.mimeType || mime || 'audio/webm').replace(/\s+/g, '') });
    const dur = (Date.now() - started) / 1000;
    if (dur < 0.7) return toast('Hold on a little longer to record.');
    if (blob.size > MAX_MEDIA_BYTES) return toast('That recording is too long to send.');
    await sendText('', null, { media: { type: 'audio', mime: blob.type, name: 'voice.webm', data: await blobB64(blob), dur } }, to);
  };
  mr.start(250);
  $('rec-time').textContent = '0:00';
  $('rec-bar').classList.remove('hidden');
  $('composer').classList.add('hidden');
}
function tickVoice() {
  if (!rec) return;
  const s = (Date.now() - rec.started) / 1000;
  $('rec-time').textContent = `${fmtDuration(s)} / ${fmtDuration(VOICE_LIMIT_S)}`;
  if (s >= VOICE_LIMIT_S) stopVoice(true);
}
function stopVoice(send) { if (!rec || rec.mr.state === 'inactive') return; rec.send = send; rec.mr.stop(); }

// ---------- chat list actions: pin, mute, archive, read, delete ----------
let menuChat = null;
function bindChatMenu(li, key) {
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); openChatMenu(key, li); });
  let timer = 0, sx = 0, sy = 0, fired = false;
  li.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    sx = e.clientX; sy = e.clientY; fired = false;
    timer = setTimeout(() => { timer = 0; fired = true; navigator.vibrate?.(15); openChatMenu(key, li); }, 500);
  });
  const cancel = () => { clearTimeout(timer); timer = 0; };
  li.addEventListener('pointerup', cancel);
  li.addEventListener('pointercancel', cancel);
  li.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  li.addEventListener('click', (e) => { if (fired) { e.stopImmediatePropagation(); fired = false; } }, true);
}
function openChatMenu(key, li) {
  menuChat = key;
  const p = prefsOf()[key] || {};
  $('chat-pin').textContent = p.pinned ? 'Unpin chat' : 'Pin chat';
  $('chat-mute').textContent = p.muted ? 'Unmute' : 'Mute';
  $('chat-archive').textContent = p.archived ? 'Unarchive' : 'Archive';
  $('chat-read').textContent = db.unread[key] ? 'Mark as read' : 'Mark as unread';
  $('chat-delete').textContent = isGroupKey(key) && inGroup(groupFor(key)) ? 'Leave and delete group' : 'Delete chat';
  wa?.onChatMenu(key);
  statusUi?.onChatMenu(key);
  extras?.onChatMenu(key);
  const menu = $('chat-menu');
  menu.classList.remove('hidden');
  const rc = li.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let top = rc.bottom - 4;
  if (top + h > innerHeight - 8) top = Math.max(8, rc.top - h + 4);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.min(Math.max(8, rc.left + 40), innerWidth - w - 8)}px`;
  menu.querySelector('button')?.focus();
}
function closeChatMenu() { $('chat-menu').classList.add('hidden'); }
function setChatPref(key, field, on) {
  const p = (prefsOf()[key] ??= {});
  if (field === 'pinned' && on) {
    const pinned = Object.values(prefsOf()).filter((x) => x.pinned).length;
    if (pinned >= MAX_PINNED) { toast(`You can pin up to ${MAX_PINNED} chats.`); return; }
    p.pinned = Date.now();
  } else if (on) p[field] = true; else delete p[field];
  if (field === 'archived' && on) delete p.pinned;
  if (!Object.keys(p).length) delete prefsOf()[key];
  persist(); renderContacts();
  if (key === active) renderThreadHead();
}
async function deleteChat(key) {
  const g = groupFor(key);
  if (!confirm(g ? `Leave “${g.name}” and delete it from this device?` : `Delete the chat with ${key} from this device? They keep their copy.`)) return;
  if (g && inGroup(g)) await leaveGroup(key);
  if (g) delete groupsOf()[g.id];
  else if (db.contacts[key]) db.contacts[key].viaGroup = true; // stays a known contact, out of the list
  delete db.threads[key]; delete db.unread[key]; delete prefsOf()[key];
  if (active === key) closeThread();
  persist(); renderContacts();
}

// ---------- groups ----------
function contactPicker(exclude = []) {
  const ul = $('group-pick');
  ul.replaceChildren();
  const hs = Object.keys(db.contacts).filter((h) => db.contacts[h].list && !db.contacts[h].pendingAccount && !exclude.includes(h)).sort((a, b) => lastTs(b) - lastTs(a));
  if (!hs.length) ul.append(el('li', 'contacts-empty', 'Start a chat with someone first, then add them here.'));
  for (const h of hs) {
    const li = el('li');
    const lab = el('label', 'pick');
    const cb = el('input');
    cb.type = 'checkbox'; cb.value = h;
    lab.append(cb, avatarEl(h), el('span', 'contact-name', h));
    li.append(lab);
    ul.append(li);
  }
}
let groupDialogMode = 'create';
function openNewGroup() {
  groupDialogMode = 'create';
  $('group-dialog-title').textContent = 'New group';
  $('group-create').textContent = 'Create group';
  $('group-name').closest('.field').classList.remove('hidden');
  $('group-name').value = '';
  $('group-error').textContent = '';
  contactPicker();
  $('group-dialog').showModal();
  $('group-name').focus();
}
async function createGroup(name, members) {
  const id = newMessageId();
  const g = newGroup(id, name, db.handle, members);
  groupsOf()[id] = { ...g, created: Date.now() };
  const key = groupKey(id);
  db.threads[key] = [];
  systemLine(key, `You created “${g.name}”`);
  persist();
  await sendControl(key, { kind: 'group', op: 'create', group: g });
  openThread(key);
}
async function addToGroup(key, members) {
  const g = groupFor(key);
  if (!inGroup(g) || !members.length) return;
  await ensureContacts(members);
  for (const h of members) if (!g.members.includes(h)) g.members.push(h);
  systemLine(key, `You added ${members.join(', ')}`);
  persist();
  await sendControl(key, { kind: 'group', op: 'add', group: { id: g.id, name: g.name, members: g.members } });
  renderThreadHead(); renderMessages(); renderGroupInfo();
}
async function renameGroup(key, name) {
  const g = groupFor(key);
  const clean = name.trim().slice(0, 64);
  if (!inGroup(g) || !clean || clean === g.name) return;
  g.name = clean;
  systemLine(key, `You renamed the group to “${clean}”`);
  persist();
  await sendControl(key, { kind: 'group', op: 'rename', group: { id: g.id, name: g.name, members: g.members } });
  renderThreadHead(); renderMessages(); renderContacts();
}
async function leaveGroup(key) {
  const g = groupFor(key);
  if (!inGroup(g)) return;
  await sendControl(key, { kind: 'group', op: 'leave', group: { id: g.id, name: g.name, members: g.members } });
  g.members = g.members.filter((h) => h !== db.handle);
  g.left = true;
  systemLine(key, 'You left');
  persist();
  if (active === key) { renderThreadHead(); renderKeyWarning(); renderMessages(); }
  renderContacts();
}
function renderGroupInfo() {
  const g = groupFor(active);
  if (!g) return;
  $('ginfo-name').value = g.name;
  $('ginfo-count').textContent = `${g.members.length} members`;
  const ul = $('ginfo-members');
  ul.replaceChildren();
  for (const h of g.members) {
    const li = el('li', 'ginfo-member');
    li.append(avatarEl(h), el('span', 'contact-name', h === db.handle ? `${h} (you)` : h));
    ul.append(li);
  }
  const me = inGroup(g);
  for (const id of ['ginfo-rename', 'ginfo-add', 'ginfo-leave']) $(id).disabled = !me;
}

// ---------- notifications ----------
function notifyIncoming(key, entry) {
  if ((prefsOf()[key]?.muted && !mentionsMe(entry.text, db.handle)) || !userPrefs().notify || !document.hidden) return; // a mention gets through a mute
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const full = isGroupKey(key) ? `${shortName(entry.from)}: ${mediaLabel(entry.media, entry.text)}` : mediaLabel(entry.media, entry.text);
  const shown = statusUi?.isLockedAny(key) ? { title: 'FabriC++', body: 'New message' } // a locked chat doesn't show who or what
    : desk ? desk.notification(key, entry, full) : { title: chatName(key), body: full };
  if (!shown) return;
  try {
    const n = new Notification(shown.title, { body: shown.body, tag: key, silent: Boolean(desk) });
    n.onclick = () => { window.focus(); openThread(key); n.close(); };
  } catch { /* not allowed here (e.g. the Android app) */ }
}

// ---------- New: message, voice or video call, group, phone number ----------
function openNewSheet() { $('new-sheet').showModal(); }
let pickHandler = null;
function openPicker(title, onPick) {
  $('pick-title').textContent = title;
  const ul = $('pick-list');
  ul.replaceChildren();
  const hs = Object.keys(db.contacts).filter((h) => db.contacts[h].list && !db.contacts[h].pendingAccount && !db.contacts[h].viaGroup).sort((a, b) => lastTs(b) - lastTs(a));
  if (!hs.length) ul.append(el('li', 'contacts-empty', 'No contacts yet. Start a chat with someone by their +name first.'));
  for (const h of hs) {
    const b = el('button', 'fwd-to');
    b.type = 'button';
    b.append(avatarEl(h), el('span', 'contact-name', h));
    b.onclick = () => { $('pick-dialog').close(); onPick(h); };
    const li = el('li');
    li.append(b);
    ul.append(li);
  }
  pickHandler = onPick;
  $('pick-dialog').showModal();
}
function startNew(kind) {
  $('new-sheet').close();
  if (kind === 'text') return $('new-chat').click();
  if (kind === 'voice') return openPicker('FabVoice™ call', (h) => calls?.start(h, false));
  if (kind === 'video') return openPicker('FabVid™ call', (h) => calls?.start(h, true));
  if (kind === 'group') return openNewGroup();
  if (kind === 'phone') return openNumberDialog();
  if (kind === 'calls' || kind === 'settings') {
    if (active) closeThread();
    return switchTab(kind);
  }
}

// ---------- linked phone numbers ----------
let numberStatus = null;
async function lookupNumber(n) {
  try {
    const r = await request({ type: 'number_lookup', numbers: [n] });
    return r.results?.[n] || null;
  } catch (e) {
    if (/not available/.test(e.message)) return null;
    throw e;
  }
}
function onNumberStatus(msg) {
  numberStatus = msg;
  if (msg.reason === 'claimed' && db.myNumber) {
    toast(`${formatNumber(db.myNumber)} was verified by another account, so it's no longer linked to yours.`);
    delete db.myNumber;
    persist();
  }
  if (!msg.linked && db.myNumber && !numberPending) { delete db.myNumber; persist(); }
  renderNumber();
}
let numberPending = null; // the number a code was sent to
function numberMsg(text, bad = false) {
  $('number-msg').textContent = text;
  $('number-msg').classList.toggle('error', bad);
}
function renderNumber() {
  const st = numberStatus;
  $('number-card').classList.toggle('hidden', !st?.enabled);
  if (!st?.enabled) return;
  const linked = st.linked && !st.linked.expired;
  $('number-form').classList.toggle('hidden', Boolean(linked || numberPending));
  $('code-form').classList.toggle('hidden', !numberPending || Boolean(linked));
  $('number-linked').classList.toggle('hidden', !linked);
  if (linked) {
    $('number-mine').textContent = db.myNumber ? formatNumber(db.myNumber) : 'Linked (verified on another device)';
    $('number-when').textContent = `Verified ${new Date(st.linked.verifiedAt).toLocaleDateString()} · renew by ${new Date(st.linked.expiresAt).toLocaleDateString()}`;
    $('number-discoverable').checked = st.linked.discoverable;
  } else if (st.linked?.expired && !numberPending) {
    numberMsg('Your link lapsed after a year. Verify the number again to keep it.');
  }
}
$('number-form').onsubmit = async (e) => {
  e.preventDefault();
  const n = toE164($('number-input').value, defaultCountry());
  if (!n) return numberMsg('Enter your full number, like +1 555 123 4567.', true);
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    await request({ type: 'number_verify_start', number: n });
    numberPending = n;
    numberMsg(`We texted a code to ${formatNumber(n)}.`);
    renderNumber();
    $('code-input').value = '';
    $('code-input').focus();
  } catch (err) {
    numberMsg(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
};
$('code-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await request({ type: 'number_verify_check', code: $('code-input').value.trim() });
    db.myNumber = numberPending;
    numberPending = null;
    persist();
    onNumberStatus(r);
    numberMsg('Linked. Turn on "Let people find me by my number" when you want FabriC++ users to reach you through it.');
  } catch (err) {
    numberMsg(err.message, true);
    if (/send a new one/.test(err.message)) { numberPending = null; renderNumber(); }
  }
};
$('code-cancel').onclick = () => { numberPending = null; numberMsg(''); renderNumber(); };
$('number-discoverable').onchange = async (e) => {
  try { onNumberStatus(await request({ type: 'number_discoverable', on: e.target.checked })); } catch (err) { numberMsg(err.message, true); renderNumber(); }
};
$('number-unlink').onclick = async () => {
  if (!confirm('Unlink your phone number? FabriC++ users will no longer find you by it.')) return;
  try {
    delete db.myNumber;
    persist();
    onNumberStatus(await request({ type: 'number_unlink' }));
    numberMsg('Unlinked.');
  } catch (err) { numberMsg(err.message, true); }
};

/** + → Call a phone number: encrypted when the number belongs to someone on FabriC++. */
function openNumberDialog() {
  $('num-input').value = '';
  $('num-result').replaceChildren();
  $('num-dialog').classList.remove('has-result');
  $('num-dialog').showModal();
  if (!isTouch()) $('num-input').focus(); // on a phone the dial pad is the keyboard
}
mountDialpad($('num-pad'), { input: $('num-input') });
// typing again after a lookup brings the pad back
$('num-input').addEventListener('input', () => {
  if (!$('num-dialog').classList.contains('has-result')) return;
  $('num-dialog').classList.remove('has-result');
  $('num-result').replaceChildren();
});
$('num-close').onclick = () => $('num-dialog').close();
$('num-form').onsubmit = async (e) => {
  e.preventDefault();
  const out = $('num-result');
  const n = toE164($('num-input').value, defaultCountry());
  out.replaceChildren();
  if (!n) return out.append(el('p', 'error small', 'Enter a full number, like +1 555 123 4567.'));
  out.append(el('p', 'muted small', 'Looking it up…'));
  $('num-dialog').classList.add('has-result');
  let h = null;
  try { h = await lookupNumber(n); } catch (err) { out.replaceChildren(el('p', 'error small', err.message)); return; }
  out.replaceChildren();
  const btn = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; b.onclick = () => { $('num-dialog').close(); fn(); }; return b; };
  const sim = canSimCall();
  const simRow = (cls) => { const r = el('div', 'num-actions'); r.append(simBtn(cls)); return r; };
  const simBtn = (cls) => btn('Call with your SIM', cls, () => { if (!simCall(n)) toast('Could not open the phone dialer.'); });
  const simNote = () => el('p', 'muted small', 'Opens your phone’s dialer. Not end-to-end encrypted: your carrier handles the call and bills it as a normal call.');
  if (h) {
    out.append(el('p', 'num-found', `${formatNumber(n)} is ${h} on FabriC++.`));
    const row = el('div', 'num-actions');
    row.append(
      btn('FabVoice', 'primary', async () => { await addContact(h).catch(() => {}); calls?.start(h, false); }),
      btn('FabVid', 'ghost', async () => { await addContact(h).catch(() => {}); calls?.start(h, true); }),
      btn('FabText', 'ghost', () => addContact(h).catch((err) => toast(err.message))),
    );
    out.append(row, el('p', 'muted small', 'End-to-end encrypted: this never touches the phone network.'));
    if (sim) out.append(simRow('ghost'), simNote());
    return;
  }
  out.append(el('p', 'small', `No one on FabriC++ is findable at ${formatNumber(n)}.`));
  if (sim) out.append(simRow('primary'), simNote());
  if (phone?.status?.enabled) {
    out.append(btn('Call over the phone network', 'ghost', () => { switchTab('phone'); phone.dial(n); }),
      el('p', 'muted small', 'Through FabriC++ Phone. Not end-to-end encrypted: the carrier handles the call.'));
  } else if (!sim) {
    out.append(el('p', 'muted small', 'Calls to regular phones are not set up on this relay. In the Android app you can call with your SIM.'));
  }
};

// The Android app can hand a number to the phone's own dialer (ACTION_DIAL: the person presses Call
// there, so a page can never place a call by itself). Browsers and tablets without a SIM get nothing.
function canSimCall() {
  try { return Boolean(window.FabricShell?.canCarrierCall?.()); } catch { return false; }
}
function simCall(e164) {
  try { return Boolean(window.FabricShell?.carrierCall?.(String(e164).replace(/[^0-9+*#]/g, ''))); } catch { return false; }
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
  desk?.onSignedIn();
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
    groups: data.groups || {}, chatPrefs: data.chatPrefs || {}, ...(data.prefs ? { prefs: data.prefs } : {}),
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
function portableState({ media = false } = {}) {
  const contacts = {};
  for (const [h, c] of Object.entries(db.contacts)) {
    if (c.account && c.list) contacts[h] = { account: c.account, list: c.list, verified: c.verified, addedAt: c.addedAt, dk: c.dk };
  }
  const threads = {};
  for (const [h, t] of Object.entries(db.threads)) {
    threads[h] = t.slice(-HISTORY_SNAPSHOT).map(({ out, anyQueued, okCopies, failedCopies, lastError, ...m }) => {
      if (m.media && !media) { const { data, ...rest } = m.media; return { ...m, media: rest }; }
      return m;
    });
  }
  return { contacts, threads, groups: db.groups || {}, chatPrefs: db.chatPrefs || {}, prefs: db.prefs };
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
  const file = await sealBackup(recovery, { v: 3, handle: db.handle, account: accountKey, ...portableState({ media: true }) });
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
      groups: content.groups || {}, chatPrefs: content.chatPrefs || {}, ...(content.prefs ? { prefs: content.prefs } : {}),
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

async function lockApp() {
  desk?.saveDraft(active);
  await persist().catch(() => {});
  vault.lock();
  location.reload(); // drops every key from memory
}
$('sec-lock').onclick = lockApp;

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
  desk?.clearDraft(active);
  sendText(t);
};
$('translate-out').onchange = (e) => {
  if (!active) return;
  const v = e.target.value;
  if (LANG_RE.test(v)) aiPrefs().out[active] = v; else delete aiPrefs().out[active];
  updateTrBadge();
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
  if (!/^[+@]/.test(i.value)) i.value = '+';
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
  if (!$('viewer').classList.contains('hidden')) closeViewer();
  else if (!$('chat-menu').classList.contains('hidden')) closeChatMenu();
  else if (rec) stopVoice(false);
  else if (!$('msg-menu').classList.contains('hidden')) closeMsgMenu();
  else if (composeCtx) clearComposeCtx();
  else if (!$('thread-menu').classList.contains('hidden')) closeThreadMenu();
  else if (!$('thread-search').classList.contains('hidden')) closeThreadSearch();
});
$('thread-search-btn').onclick = () => openThreadSearch();
$('attach').onclick = () => $('attach-input').click();
$('attach-input').onchange = (e) => { const file = e.target.files?.[0]; e.target.value = ''; sendAttachment(file); };
$('mic').onclick = startVoice;
$('rec-cancel').onclick = () => stopVoice(false);
$('rec-send').onclick = () => stopVoice(true);
$('text').addEventListener('input', noteTyping);
$('text').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); desk ? desk.sendFiles(files) : sendAttachment(files[0]); }
});
$('viewer').onclick = closeViewer;
$('new-group').onclick = openNewGroup;
$('new-action').onclick = openNewSheet;
spacesUi = mountSpaces({
  request, wsSend, toast, switchTab, me: () => db.handle,
  vault: { get: () => db, save: () => persist() },
  // automatic translation of posts, on this device (the same models and switches as chats)
  translation: {
    on: (sid) => translating(`space:${sid}`),
    toggle: (sid) => { const on = toggleChat(aiPrefs(), `space:${sid}`); persist(); return on; },
    translate: (text, opts) => ai.translate(text, opts),
    noteEl: (tr, original, key, rerender) => trNoteEl(tr, original, key, rerender),
    shouldAsk: () => shouldAsk(aiPrefs()),
    answer: (keep) => { setAuto(aiPrefs(), keep); aiAsk = null; persist(); if (active) renderMessages(); },
    mb: (from) => ai.translationMb(from),
    name: (c) => languageName(c),
    target: () => ai.target,
  },
  // a space key goes over the one-to-one encrypted session; to myself = my other devices only
  sendKey: async (h, payload) => {
    if (h !== db.handle) await ensureContacts([h]);
    await sendControl(h, payload, { self: h === db.handle });
  },
});
for (const b of document.querySelectorAll('[data-new]')) b.onclick = () => startNew(b.dataset.new);
$('new-sheet').addEventListener('click', (e) => { if (e.target === $('new-sheet')) $('new-sheet').close(); }); // tap outside
$('pick-cancel').onclick = () => $('pick-dialog').close();
$('group-cancel').onclick = () => $('group-dialog').close();
$('group-create').onclick = async () => {
  const picked = [...$('group-pick').querySelectorAll('input:checked')].map((i) => i.value);
  try {
    if (groupDialogMode === 'add') { $('group-dialog').close(); await addToGroup(active, picked); return; }
    if (!picked.length) throw new Error('Pick at least one person.');
    $('group-dialog').close();
    await createGroup($('group-name').value, picked);
  } catch (err) { $('group-error').textContent = err.message; if (!$('group-dialog').open) toast(err.message); }
};
$('group-info-btn').onclick = () => { renderGroupInfo(); $('ginfo-dialog').showModal(); };
$('ginfo-close').onclick = () => $('ginfo-dialog').close();
$('ginfo-rename').onclick = () => renameGroup(active, $('ginfo-name').value);
$('ginfo-add').onclick = () => {
  $('ginfo-dialog').close();
  groupDialogMode = 'add';
  $('group-dialog-title').textContent = `Add to ${chatName(active)}`;
  $('group-create').textContent = 'Add';
  $('group-name').closest('.field').classList.add('hidden');
  $('group-error').textContent = '';
  contactPicker(groupFor(active)?.members || []);
  $('group-dialog').showModal();
};
$('ginfo-leave').onclick = async () => {
  if (!confirm(`Leave “${chatName(active)}”? You'll stop getting its messages.`)) return;
  $('ginfo-dialog').close();
  await leaveGroup(active);
};
$('mute-chat').onclick = () => active && setChatPref(active, 'muted', !prefsOf()[active]?.muted);
$('archive-chat').onclick = () => {
  if (!active) return;
  const on = !prefsOf()[active]?.archived;
  setChatPref(active, 'archived', on);
  if (on) { closeThread(); toast('Chat archived'); }
};
$('chat-pin').onclick = () => { const k = menuChat; closeChatMenu(); if (k) setChatPref(k, 'pinned', !prefsOf()[k]?.pinned); };
$('chat-mute').onclick = () => { const k = menuChat; closeChatMenu(); if (k) setChatPref(k, 'muted', !prefsOf()[k]?.muted); };
$('chat-archive').onclick = () => { const k = menuChat; closeChatMenu(); if (k) setChatPref(k, 'archived', !prefsOf()[k]?.archived); };
$('chat-read').onclick = () => {
  const k = menuChat; closeChatMenu();
  if (!k) return;
  if (db.unread[k]) { delete db.unread[k]; sendReceipts(k); } else db.unread[k] = 1;
  persist(); renderContacts();
};
$('chat-delete').onclick = () => { const k = menuChat; closeChatMenu(); if (k) deleteChat(k); };
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#chat-menu')) closeChatMenu(); }, true);
$('photo-pick').onclick = () => $('photo-file').click();
$('settings-photo').onclick = () => $('photo-file').click();
$('photo-file').onchange = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openPhotoDialog(f); };
$('photo-remove').onclick = () => setMyPhoto(null);
$('photo-zoom').oninput = (e) => { photoCrop.zoom = Number(e.target.value) || 1; renderPhotoPreview(); };
for (const b of document.querySelectorAll('#photo-move [data-nudge]')) {
  b.onclick = () => {
    const [x, y] = b.dataset.nudge.split(',').map(Number);
    photoCrop.dx = Math.max(-1, Math.min(1, photoCrop.dx + x * 0.25));
    photoCrop.dy = Math.max(-1, Math.min(1, photoCrop.dy + y * 0.25));
    renderPhotoPreview();
  };
}
$('photo-cancel').onclick = () => { $('photo-dialog').close(); photoBitmap?.close?.(); photoBitmap = null; };
$('photo-use').onclick = async () => {
  const data = await squarePhoto(photoBitmap, photoCrop);
  $('photo-dialog').close(); photoBitmap?.close?.(); photoBitmap = null;
  setMyPhoto(data);
};
$('pref-receipts').onchange = (e) => { userPrefs().receipts = e.target.checked; persist(); if (active) renderMessages(); };
$('pref-typing').onchange = (e) => { userPrefs().typing = e.target.checked; persist(); };
$('pref-notify').onchange = async (e) => {
  let on = e.target.checked;
  if (on && Notification.permission !== 'granted') on = (await Notification.requestPermission().catch(() => 'denied')) === 'granted';
  userPrefs().notify = on;
  e.target.checked = on;
  if (!on && e.target.checked !== on) toast('Notifications are blocked in this browser.');
  persist();
};
$('pref-theme').onchange = (e) => applyTheme(e.target.value);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && active) { delete db.unread[active]; sendReceipts(active); renderContacts(); }
});
$('msg-reply').onclick = () => { const m = menuMsg; closeMsgMenu(); if (m) setComposeCtx({ mode: 'reply', quote: quoteOf({ ...m, text: mediaLabel(m.media, m.text) }) }); };
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
  if (!active || !confirm(`Delete every message in ${chatName(active)} from this device? Others keep their copy.`)) return;
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
const growText = () => {
  const t = $('text');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
  $('composer').classList.toggle('has-text', Boolean(t.value.trim()));
};
$('text').addEventListener('input', growText);
$('composer').addEventListener('submit', () => setTimeout(growText));

desk = installDesk({
  $, el, toast, svgIcon, profile: PROFILE,
  db: () => db, active: () => active, persist, prefsOf, userPrefs, setChatPref, chatKeys, chatName, chatAvatar, isGroupKey,
  openThread, renderContacts, renderThreadHead, switchTab, openThreadSearch, jumpTo, blobUrl, growText, sendAttachment,
  sendText: (...a) => sendText(...a), composeMode: () => composeCtx?.mode || null,
  replyExtra: () => { if (composeCtx?.mode !== 'reply') return {}; const r = { reply: composeCtx.quote }; clearComposeCtx(); return r; },
  startEdit: (m) => { setComposeCtx({ mode: 'edit', id: m.id, original: m.text }); $('text').value = m.text; growText(); $('text').focus(); },
  menuChat: () => menuChat, closeChatMenu, menuMsg: () => menuMsg, closeMsgMenu, renderMessages,
  sendAction: (...a) => sendAction(...a), sendControl: (...a) => sendControl(...a), systemLine,
  passphraseSet: async () => (await vault.meta())?.mode === 'passphrase', lock: lockApp,
});
wa = installWa({
  $, el, toast, SAVED, db: () => db, active: () => active, persist, userPrefs, sendText: (...a) => sendText(...a),
  sendAttachment: (...a) => sendAttachment(...a), renderMessages, renderContacts, chatKeys, chatName, isGroupKey, groupFor,
  avatarEl, addContact, openThread, jumpTo, systemLine, growText, setMyAbout,
  menuMsg: () => menuMsg, closeMsgMenu, menuChat: () => menuChat, closeChatMenu,
  openEvent: (to) => extras?.openEvent(to), openStickers: (to) => extras?.openStickers(to),
});
extras = installExtras({
  $, el, toast, db: () => db, active: () => active, persist, prefsOf, setChatPref,
  sendText: (...a) => sendText(...a), sendAction: (...a) => sendAction(...a),
  menuMsg: () => menuMsg, closeMsgMenu, menuChat: () => menuChat, closeChatMenu,
});
statusUi = installStatus({
  $, el, toast, SAVED, db: () => db, active: () => active, persist, userPrefs, prefsOf, setChatPref, chatKeys, chatName, isGroupKey, lastTs,
  isBotHandle, avatarEl, imageMedia, openThread, closeThread, renderContacts, growText,
  sendText: (...a) => sendText(...a), sendControl: (...a) => sendControl(...a),
  menuChat: () => menuChat, closeChatMenu,
});
bots = installBots({
  $, el, toast, SAVED: typeof SAVED === 'undefined' ? null : SAVED, db: () => db, active: () => active, persist, isGroupKey, groupFor, addContact,
  signedIn: () => registered, renderMessages, renderThreadHead, sendControl: (...a) => sendControl(...a), sendText: (...a) => sendText(...a),
  // a bot's answer to a button press, translated on this device (only if the model is already here)
  translateAnswer: async (from, text) => {
    if (!translating(from)) return null;
    const r = await ai.translate(text);
    return r?.text ? `${String(r.text).slice(0, 400)} · translated from ${languageName(r.from)}` : null;
  },
});
startHandleDisplay();
boot();
