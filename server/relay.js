// FABRIC relay: account directory (signed device lists), store-and-forward of ciphertext per
// device, prekey bundles, link mailboxes, consent receipts, metadata counters and a
// hash-chained settlement ledger (stand-in for Firmament Network).
// The relay never holds a key that can decrypt a message or sign a device list.
//
// v0.6 hardening: SQLite storage committed before every ack, store-until-acknowledged delivery,
// rate limits and one-time-prekey drain protection, daily caps on revenue-share counters,
// operator token for settlement, WebSocket origin checks, heartbeats, optional TLS.
// v0.9 sealed sender: envelopes can arrive over an unregistered socket, encrypted so that only
// the recipient learns the sender. The relay checks the recipient's delivery key instead.
// v0.12 Cumulus://ID: addresses can be linked to a CID account (OpenID Connect, server/cid.js),
// which also keeps the account's encrypted backup for restoring on a new device.
// Scalvs: SCALVS.ai as the contact +scalvs.veil (server/scalvs.js), an ordinary device the relay
// starts next to itself. The relay only reserves the handle for Scalvs's account key.
// Bots: the Bot API (server/bots.js) at /bot<token>/<method>. Bot accounts are devices the relay
// runs; new addresses ending in "bot" are reserved for them.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  generateIdentity, ownershipProof, timingSafeEqualB64, isValidHandle, normalizeHandle, isPublicJwk, publicOnly, b64,
} from '../shared/crypto.js';
import { verifySignedPreKey, verifyPqPreKey } from '../shared/ratchet.js';
import { verifyDeviceList, findDevice, deviceAddr, parseAddr, DEVICE_ID_RE } from '../shared/devices.js';
import { PURPOSES, defaultConsent, contributionWeight, allocate } from '../shared/economy.js';
import { openStore } from './store.js';
import { backupFromEnv, createBackup } from './backup.js';
import { defaultLimits, MAX_SOCKETS_PER_IP, DAILY_CAPS } from './limits.js';
import { phoneFromEnv, createPhone, E164_RE } from './phone.js';
import { linksFromEnv, createLinks } from './links.js';
import { createSfu } from './sfu.js';
import { createModelProxy, modelsFromEnv } from './models.js';
import { createSfuCluster, clusterFromEnv } from './sfu-cluster.js';
import { newDeliveryKey, isDeliveryKey, isSealed } from '../shared/sealed.js';
import { cidFromEnv, createCid } from './cid.js';
import { turnFromEnv, turnCredentials } from './turn.js';
import { createScalvs, scalvsFromEnv, isScalvsAccount, SCALVS_HANDLE } from './scalvs.js';
import { aiFromEnv, createAi } from './scalvs-ai.js';
import { localAiFromEnv, createLocalAi } from './scalvs-local.js';
import { createBots, botsFromEnv } from './bots.js';
import { isBotHandle } from '../shared/bots.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ENVELOPE_BYTES = 512 * 1024; // link payloads carry a history snapshot
const MAX_QUEUE = 1000;
const MAX_OPKS = 200;
const MAILBOX_TTL_MS = 10 * 60 * 1000;
const QUEUE_TTL_MS = 30 * 24 * 3600 * 1000;
const HEARTBEAT_MS = 30_000;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024; // cloud backup (encrypted with the recovery key)
const TICKET_TTL_MS = 5 * 60 * 1000;
const ABUSE_CLOSE_AFTER = 200; // rate-limited messages on one connection before it is closed
export const FAB_PER_USD = 10; // demo conversion rate, recorded on every settlement

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
// Transformers.js and the ONNX Runtime files it loads, served from node_modules (on-device AI)
const VENDOR_AI = {
  '/vendor/transformers.js': ['@huggingface', 'transformers', 'dist', 'transformers.min.js'],
  ...Object.fromEntries(['', '.asyncify', '.jsep'].flatMap((v) => ['.mjs', '.wasm'].map((ext) => [
    `/vendor/ort/ort-wasm-simd-threaded${v}${ext}`, ['onnxruntime-web', 'dist', `ort-wasm-simd-threaded${v}${ext}`]]))),
};
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const randomId = () => b64(globalThis.crypto.getRandomValues(new Uint8Array(18))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);

/** STUN/TURN for calls, from FABRIC_ICE_SERVERS (JSON array of RTCIceServer). Empty = same network only. */
function iceFromEnv() {
  try {
    const v = JSON.parse(process.env.FABRIC_ICE_SERVERS || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    console.warn('[relay] FABRIC_ICE_SERVERS is not valid JSON; calls will only work on the same network');
    return [];
  }
}

/** Options for the SFU's own WebRTC endpoint, or null when FABRIC_SFU=0 turns it off. */
function sfuFromEnv() {
  if (process.env.FABRIC_SFU === '0') return null;
  const cfg = {};
  // the address browsers reach the relay at, when it differs from its interfaces (NAT, containers)
  const ip = listEnv(process.env.FABRIC_SFU_PUBLIC_IP);
  if (ip.length) cfg.iceAdditionalHostAddresses = ip;
  const range = /^(\d+)-(\d+)$/.exec(process.env.FABRIC_SFU_PORTS || '');
  if (range) cfg.icePortRange = [Number(range[1]), Number(range[2])];
  return cfg;
}

function tlsFromEnv() {
  const { FABRIC_TLS_CERT: cert, FABRIC_TLS_KEY: key } = process.env;
  return cert && key ? { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } : null;
}

const listEnv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function sameSecret(given, expected) {
  // hash first so lengths always match and nothing about the token leaks through timing
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

export async function createRelay({
  port = 8787,
  dataFile = process.env.FABRIC_DB || path.join(ROOT, 'data', 'fabric.db'),
  legacyJson = path.join(ROOT, 'data', 'state-v3.json'),
  log = console.log,
  iceServers = iceFromEnv(),
  operatorToken = process.env.FABRIC_OPERATOR_TOKEN || null,
  tls = tlsFromEnv(),
  origins = listEnv(process.env.FABRIC_ORIGINS),
  trustProxy = process.env.FABRIC_TRUST_PROXY === '1',
  limits = defaultLimits(),
  heartbeatMs = HEARTBEAT_MS,
  phone = phoneFromEnv(),
  links = linksFromEnv(),
  linkVerifier = undefined, // tests
  linkClock = undefined,    // tests
  fetchImpl = globalThis.fetch,
  modelFetch = undefined, // model downloads: node http by default (see server/models.js)
  sfu = sfuFromEnv(),
  cid = cidFromEnv(),
  turn = turnFromEnv(),
  sfuNodes = clusterFromEnv(),
  models = modelsFromEnv(process.env, ROOT),
  scalvs = null, // { stateFile, ai }: run Scalvs next to this relay (see scalvsFromEnv)
  bots = null,   // { stateDir, allowLocalWebhooks }: the Bot API and +forgebot (see botsFromEnv)
} = {}) {
  const store = openStore(dataFile, { importJson: dataFile ? legacyJson : null });
  const relayIdentity = await generateIdentity(); // per-process; used only for ownership proofs
  // Scalvs's keys are loaded before the relay listens, so its handle is reserved from the start.
  // `ai` is either a config from aiFromEnv or (tests) anything with ask(handle, text).
  const scalvsAi = !scalvs?.ai ? null : typeof scalvs.ai.ask === 'function' ? scalvs.ai
    : scalvs.ai.local ? createLocalAi({ ...scalvs.ai, log }) : createAi({ ...scalvs.ai, log }); // open model, or Claude
  const bot = scalvs ? await createScalvs({ stateFile: scalvs.stateFile ?? null, ai: scalvsAi, log }) : null;
  const botHub = bots ? await createBots({ ...bots, isTaken: (h) => Boolean(store.getList(h)), log }) : null;
  // the hub's own bot sockets (loopback, with its secret) are not counted against per-IP limits
  const fromHub = (req) => Boolean(botHub) && LOCAL.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for']
    && typeof req.headers['x-fabric-bot-hub'] === 'string' && sameSecret(req.headers['x-fabric-bot-hub'], botHub.hubSecret);
  const online = new Map(); // "handle#device" -> ws
  const mailboxes = new Map(); // id -> { ws, expires }
  const socketsPerIp = new Map();
  let cidSvc = null; // made once the port is known (the redirect address includes it)
  const tickets = new Map(); // backup upload/download tickets: id -> { kind, handle, expires }
  const newTicket = (kind, handle) => { const id = randomId(); tickets.set(id, { kind, handle, expires: Date.now() + TICKET_TTL_MS }); return id; };
  const takeTicket = (id, kind) => {
    const t = typeof id === 'string' && tickets.get(id);
    if (!t || t.kind !== kind || t.expires < Date.now()) return null;
    tickets.delete(id); // one use
    return t;
  };

  const socketsOf = (handle) => [...online.entries()].filter(([a]) => parseAddr(a).handle === handle).map(([, w]) => w);
  const phoneSvc = phone
    ? createPhone({ cfg: phone, store, log, fetchImpl, notify: (h, msg) => { for (const w of socketsOf(h)) send(w, msg); } })
    : null;
  // linked phone numbers: dev mode (codes in the log) only when every allowed origin is local
  const localOnly = origins.length > 0 && origins.every((o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
  if (links?.mode === 'dev' && !localOnly) { log('FABRIC_NUMBER_VERIFY=dev ignored: a non-local origin is allowed'); links = null; }
  const linksSvc = links
    ? createLinks({ cfg: links, store, log, fetchImpl, verifier: linkVerifier, ...(linkClock ? { now: linkClock } : {}), notify: (h, msg) => { for (const w of socketsOf(h)) send(w, msg); } })
    : null;
  // large calls: on separate media nodes when FABRIC_SFU_NODES lists them, else in this process
  const toMember = (addr, msg) => send(online.get(addr), msg);
  const sfuSvc = sfuNodes ? createSfuCluster({ ...sfuNodes, log, send: toMember })
    : sfu ? createSfu({ pcConfig: sfu, log, send: toMember }) : null;
  const modelProxy = models ? createModelProxy({ ...models, log, ...(modelFetch ? { fetchImpl: modelFetch } : {}) }) : null;
  const clientIp = (req) => {
    const fwd = trustProxy && req.headers['x-forwarded-for'];
    return (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
  };

  // ---------- economy ----------
  function weights() {
    const out = {};
    for (const h of store.handles()) out[h] = contributionWeight(store.getConsent(h), store.counters(h));
    return out;
  }

  function bump(handle, purpose, n = 1) {
    if (!store.getConsent(handle)?.[purpose]) return 0; // nothing is counted without consent
    return store.bump(handle, purpose, n, DAILY_CAPS[purpose] ?? 0);
  }

  function accountFor(handle) {
    return {
      type: 'account',
      consent: store.getConsent(handle) || defaultConsent(),
      counters: store.counters(handle),
      balanceFab: store.balance(handle),
      receipts: store.receipts(handle),
      payouts: store.payouts(handle),
    };
  }

  /** Whether this account has a CID and a cloud backup. Never says which CID. */
  function cidStatus(handle) {
    const link = cidSvc && store.cidOf(handle);
    return { type: 'cid_status', enabled: Boolean(cidSvc), required: Boolean(cidSvc && cid.required), linked: Boolean(link), linkedAt: link?.linkedAt || null, backup: link ? store.backupInfo(handle) : null };
  }

  /** What anyone may see about a settlement: totals, never who gets what. */
  function aggregate(revenue) {
    const r = allocate(revenue, weights());
    return { revenueCents: r.revenueCents, poolCents: r.poolCents, infinitumCents: r.infinitumCents, participants: r.participants, fabPerUsd: FAB_PER_USD, allocations: r.allocations };
  }
  const publicAggregate = (revenue) => { const { allocations, ...rest } = aggregate(revenue); return rest; };

  function settle(revenueUsd) {
    const result = allocate(revenueUsd, weights());
    const fab = {};
    for (const [h, cents] of Object.entries(result.allocations)) fab[h] = (cents / 100) * FAB_PER_USD;
    const entry = store.recordSettlement({ kind: 'settlement', ...result, fabPerUsd: FAB_PER_USD, fab });
    for (const h of Object.keys(result.allocations)) for (const w of socketsOf(h)) send(w, accountFor(h));
    return entry;
  }

  // ---------- device lists ----------
  /** Store a verified list; drop queues, prekeys and connections of devices no longer on it. */
  function applyList(handle, list) {
    const before = store.getList(handle)?.payload.devices.map((d) => d.id) || [];
    const keep = new Set(list.payload.devices.map((d) => d.id));
    const removed = before.filter((id) => !keep.has(id)).map((id) => deviceAddr(handle, id));
    store.tx(() => {
      store.putList(handle, list);
      for (const addr of removed) store.dropDevice(addr);
    });
    for (const addr of removed) {
      online.get(addr)?.close(4001, 'device removed');
      online.delete(addr);
      log(`[relay] ${addr} removed`);
    }
  }

  // ---------- sealed sender ----------
  /** The account's delivery key, made on first use. Its own devices get it when they register. */
  function deliveryKeyOf(handle) {
    let key = store.getDeliveryKey(handle);
    if (!key) { key = newDeliveryKey(); store.setDeliveryKey(handle, key); }
    return key;
  }
  const keyMatches = (handle, key) => {
    const want = isValidHandle(handle) && store.getDeliveryKey(handle);
    return Boolean(want) && isDeliveryKey(key) && timingSafeEqualB64(key, want);
  };

  /** A prekey bundle for one device, or an error string. `requester` keys the drain limits. */
  function bundleFor(requester, addrText) {
    const { handle, deviceId } = parseAddr(String(addrText || ''));
    const list = store.getList(handle);
    const dev = list && findDevice(list.payload, deviceId);
    if (!dev) return 'unknown device';
    const addr = deviceAddr(handle, deviceId);
    const spk = store.getSpk(addr);
    if (!spk) return 'no prekeys';
    // One-time prekeys are a finite resource: a requester (or everyone together) draining
    // them only gets bundles without one. The session still works (X3DH without the OPK).
    const allowOpk = !limits.opkPair.take(`${requester}>${addr}`) && !limits.opkTarget.take(addr);
    const opk = allowOpk ? store.popOpk(addr) : null;
    if (opk) send(online.get(addr), { type: 'prekey_count', count: store.opkCount(addr), hasSpk: true });
    return { identity: { dh: dev.dh, sig: dev.sig }, spk, opk };
  }

  // ---------- http ----------
  function securityHeaders(res) {
    // Defense in depth for keys held in the page: no third-party script, no framing, no inline code.
    // 'wasm-unsafe-eval' lets on-device models compile WebAssembly (served from here); not JS eval.
    // With FABRIC Phone on, the Twilio Voice SDK (served from this origin) talks to Twilio's servers.
    const twilio = phoneSvc ? ' https://*.twilio.com wss://*.twilio.com' : '';
    res.setHeader('content-security-policy',
      `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'${twilio}; img-src 'self' data:; ` +
      `media-src 'self' blob:${phoneSvc ? ' https://sdk.twilio.com' : ''}; ` +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    // with COOP, makes the page cross-origin isolated, so on-device models can use several threads
    res.setHeader('cross-origin-embedder-policy', 'credentialless');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('permissions-policy', 'camera=(self), microphone=(self), geolocation=(), display-capture=()');
    if (tls) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

  /** Operator actions: a bearer token when configured; otherwise only a direct local connection. */
  function isOperator(req) {
    if (operatorToken) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      return Boolean(m) && sameSecret(m[1], operatorToken);
    }
    // no token: dev mode. Behind a proxy every request looks local, so forwarded ones never count.
    return LOCAL.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
  }

  async function readJson(req, max = 10_000) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > max) throw Object.assign(new Error('body too large'), { status: 413 });
    }
    try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    securityHeaders(res);
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify(obj));
    };

    // Bot API: /bot<token>/<method>, limited per bot (server/bots.js), not per IP
    if (botHub && url.pathname.startsWith('/bot') && await botHub.handleHttp(req, res, url)) return;

    if (url.pathname.startsWith('/api/')) {
      const wait = limits.httpIp.take(clientIp(req));
      if (wait) return json(429, { error: 'rate limited', retryAfter: wait }, { 'retry-after': String(wait) });
      if (url.pathname === '/api/health') return json(200, { ok: true });
      if (url.pathname === '/api/purposes') return json(200, PURPOSES);
      // TURN logins are only handed out over a signed-in socket ('ice'), never here
      if (url.pathname === '/api/models') return json(200, { available: Boolean(modelProxy) });
      if (url.pathname === '/api/ice') return json(200, { iceServers, sfu: Boolean(sfuSvc), turn: Boolean(turn) });
      if (url.pathname === '/api/bots/info') {
        const h = normalizeHandle(url.searchParams.get('handle') || '');
        if (!isValidHandle(h)) return json(400, { error: 'bad handle' });
        if (h === SCALVS_HANDLE && bot) {
          return json(200, { bot: true, system: true, handle: h, name: 'Scalvs', about: 'SCALVS.ai runs tasks for you. Send help to see them.', privacy: true, commands: [{ command: 'help', description: 'What Scalvs can do' }, { command: 'ping', description: 'Check it is there' }] });
        }
        return json(200, botHub ? botHub.info(h) : { bot: false });
      }
      if (url.pathname === '/api/scalvs') return json(200, { enabled: Boolean(bot), handle: bot ? bot.handle : null, ai: Boolean(scalvsAi), ...(scalvsAi?.model ? { model: scalvsAi.model } : {}) });
      if (url.pathname === '/api/cid') return json(200, { enabled: Boolean(cidSvc), required: Boolean(cidSvc && cid.required) });
      if (url.pathname === '/api/cid/backup') {
        if (!cidSvc) return json(404, { error: 'Cumulus://ID is not set up on this relay' });
        if (req.method === 'PUT') {
          const t = takeTicket(url.searchParams.get('ticket'), 'up');
          if (!t) return json(403, { error: 'upload ticket unknown, used or expired' });
          if (!store.cidOf(t.handle)) return json(403, { error: 'no Cumulus://ID linked' });
          const f = await readJson(req, MAX_BACKUP_BYTES);
          // only the encrypted envelope is kept; the relay can't open it (no recovery key)
          if (f?.format !== 'fabric-backup' || f.v !== 3 || f.handle !== t.handle || typeof f.salt !== 'string' || typeof f.box?.iv !== 'string' || typeof f.box?.ct !== 'string') {
            return json(400, { error: 'not a FabriC++ backup for this account' });
          }
          store.putBackup(t.handle, JSON.stringify({ format: f.format, v: f.v, createdAt: String(f.createdAt || '').slice(0, 40), handle: f.handle, salt: f.salt, box: { iv: f.box.iv, ct: f.box.ct } }));
          const info = store.backupInfo(t.handle);
          for (const w of socketsOf(t.handle)) send(w, cidStatus(t.handle));
          return json(200, info);
        }
        if (req.method === 'GET') {
          const t = takeTicket(url.searchParams.get('ticket'), 'down');
          const blob = t && store.getBackup(t.handle);
          if (!blob) return json(404, { error: 'download ticket unknown, used or expired' });
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(blob);
        }
        return json(405, { error: 'method not allowed' });
      }
      if (url.pathname === '/api/economy/preview') {
        const revenue = Number(url.searchParams.get('revenue') || 0);
        if (!(revenue >= 0 && revenue <= 1e9)) return json(400, { error: 'revenue out of range' });
        return json(200, publicAggregate(revenue)); // per-user allocations only over the user's own socket
      }
      if (url.pathname === '/api/ledger') {
        const head = store.ledgerHead();
        const out = { valid: store.verifyLedger(), length: head.seq + 1, head: head.hash };
        if (isOperator(req)) out.entries = store.ledgerRecent(50); // entries name users: operator only
        return json(200, out);
      }
      if (url.pathname === '/api/economy/settle' && req.method === 'POST') {
        if (!isOperator(req)) return json(403, { error: 'operator only' });
        const { revenue } = await readJson(req);
        const r = Number(revenue);
        if (!(r > 0 && r <= 1e9)) return json(400, { error: 'revenue out of range' });
        return json(200, settle(r));
      }
      if (url.pathname === '/api/phone/numbers') {
        // operator: which account owns which purchased number
        if (!isOperator(req)) return json(403, { error: 'operator only' });
        if (!phoneSvc) return json(404, { error: 'phone not configured' });
        if (req.method === 'POST') {
          const { number, handle } = await readJson(req);
          if (!E164_RE.test(String(number))) return json(400, { error: 'number must be E.164, like +15551234567' });
          if (handle !== null && !(isValidHandle(handle) && store.getList(handle))) return json(400, { error: 'unknown handle' });
          if (store.ownerOfNumber(number)?.burner) return json(409, { error: 'that number is lent out as a burner' });
          store.removeFromPool(number);
          store.assignNumber(number, handle);
          if (handle) phoneSvc.pushStatus(handle);
        }
        return json(200, { numbers: store.numbers() });
      }
      if (url.pathname === '/api/phone/pool') {
        // operator: numbers bought to lend out as burners
        if (!isOperator(req)) return json(403, { error: 'operator only' });
        if (!phoneSvc?.burnersEnabled) return json(404, { error: 'burner numbers are off' });
        if (req.method === 'POST') {
          const { add = [], remove = [] } = await readJson(req);
          if (!Array.isArray(add) || !Array.isArray(remove) || add.length + remove.length > 500) return json(400, { error: 'add and remove are lists of numbers' });
          const bad = [...add, ...remove].find((n) => !E164_RE.test(String(n)));
          if (bad !== undefined) return json(400, { error: `not E.164: ${String(bad).slice(0, 20)}` });
          const skipped = add.filter((n) => !store.addToPool(n));
          for (const n of remove) store.removeFromPool(n); // a number already lent stays with its owner until burned
          return json(200, { ...store.poolStats(), skipped });
        }
        return json(200, store.poolStats());
      }
      if (url.pathname === '/api/phone/bundles' && req.method === 'POST') {
        // operator: someone bought a burner bundle (payment is handled outside the relay)
        if (!isOperator(req)) return json(403, { error: 'operator only' });
        if (!phoneSvc?.burnersEnabled) return json(404, { error: 'burner numbers are off' });
        const { handle, size, period, id, expiresAt } = await readJson(req);
        if (!(isValidHandle(handle) && store.getList(handle))) return json(400, { error: 'unknown handle' });
        if (id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) return json(400, { error: 'id: up to 64 letters, digits, - or _' });
        if (expiresAt !== undefined && !(Number.isFinite(expiresAt) && expiresAt > 0)) return json(400, { error: 'expiresAt: epoch milliseconds' });
        try {
          return json(200, phoneSvc.grant({ handle, size: Number(size), period, id: id ?? randomBytes(9).toString('base64url'), expiresAt }));
        } catch (e) {
          return json(e.status || 500, { error: e.message });
        }
      }
      if (url.pathname.startsWith('/api/phone/') && phoneSvc && await phoneSvc.http(req, res, url)) return;
      return json(404, { error: 'not found' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    // static: /shared/* from shared/, everything else from public/
    if (modelProxy && await modelProxy.handle(req, res, url, clientIp(req))) return;
    if (VENDOR_AI[url.pathname]) {
      const lib = path.join(ROOT, 'node_modules', ...VENDOR_AI[url.pathname]);
      if (!fs.existsSync(lib)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(lib)], 'cache-control': 'max-age=86400' });
      return fs.createReadStream(lib).pipe(res);
    }
    if (url.pathname === '/vendor/twilio.min.js') {
      // the Twilio Voice SDK from node_modules, so pages never load third-party script
      const sdk = path.join(ROOT, 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js');
      if (!phoneSvc || !fs.existsSync(sdk)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'max-age=3600' });
      return fs.createReadStream(sdk).pipe(res);
    }
    if (url.pathname === '/vendor/jsqr.js') {
      // QR reader for device linking (where the browser has no BarcodeDetector), from node_modules
      const lib = path.join(ROOT, 'node_modules', 'jsqr', 'dist', 'jsQR.js');
      if (!fs.existsSync(lib)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'max-age=3600' });
      return fs.createReadStream(lib).pipe(res);
    }
    const noble = /^\/vendor\/noble\/(post-quantum|hashes|curves)\/((?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.js)$/i.exec(url.pathname);
    if (noble) {
      // ML-KEM-768 for post-quantum session setup (shared/pq.js), from node_modules. The packages
      // import each other by bare name, which browsers cannot resolve, so those imports are
      // rewritten to these same /vendor/noble/ paths.
      const lib = path.join(ROOT, 'node_modules', '@noble', noble[1], noble[2]);
      if (!lib.startsWith(path.join(ROOT, 'node_modules', '@noble') + path.sep) || !fs.existsSync(lib)) { res.writeHead(404); return res.end('not found'); }
      const src = fs.readFileSync(lib, 'utf8').replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])@noble\/(post-quantum|hashes|curves)\//g, '$1$2/vendor/noble/$3/');
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'max-age=3600' });
      return res.end(src);
    }
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    let base = path.join(ROOT, 'public');
    if (rel.startsWith('/shared/')) { base = path.join(ROOT, 'shared'); rel = rel.slice('/shared'.length); }
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  const onRequest = (req, res) => {
    handleHttp(req, res).catch((e) => {
      if (!e.status) log(`[relay] http error: ${e.stack || e}`);
      if (!res.headersSent) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.status ? e.message : 'internal error' })); }
    });
  };
  const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest);

  // ---------- websocket ----------
  const allowedOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser: CSWSH is a browser attack, and keys prove identity anyway
    if (origins.length) return origins.includes(origin);
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  };

  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: MAX_ENVELOPE_BYTES,
    verifyClient: ({ req }, done) => {
      const ip = clientIp(req);
      if (!allowedOrigin(req)) return done(false, 403, 'origin not allowed');
      if (fromHub(req)) return done(true);
      if ((socketsPerIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP) return done(false, 429, 'too many connections');
      if (limits.connectIp.take(ip)) return done(false, 429, 'rate limited');
      done(true);
    },
  });

  function send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  const timers = [
    setInterval(() => {
      const now = Date.now();
      for (const [id, m] of mailboxes) if (m.expires < now) mailboxes.delete(id);
      for (const [id, t] of tickets) if (t.expires < now) tickets.delete(id);
      cidSvc?.sweep();
      for (const b of Object.values(limits)) b.sweep();
    }, 60_000),
    setInterval(() => {
      const dropped = store.expireQueues(Date.now() - QUEUE_TTL_MS);
      store.pruneDaily();
      phoneSvc?.expire();
      if (dropped) log(`[relay] expired ${dropped} undelivered envelopes`);
    }, 3600_000),
    setInterval(() => {
      // a half-open socket would otherwise look online forever
      for (const ws of wss.clients) {
        if (ws.alive === false) { ws.terminate(); continue; }
        ws.alive = false;
        ws.ping();
      }
    }, heartbeatMs),
  ];
  for (const t of timers) t.unref();

  wss.on('connection', (ws, req) => {
    const ip = fromHub(req) ? `bot-hub:${randomId()}` : clientIp(req);
    socketsPerIp.set(ip, (socketsPerIp.get(ip) || 0) + 1);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const connKey = randomId();
    const nonce = b64(globalThis.crypto.getRandomValues(new Uint8Array(24)));
    let me = null; // { handle, deviceId, addr }
    let mailbox = null;
    let strikes = 0;
    let cidProof = null; // { key, email } from a finished 'register' sign-in on this socket
    const openMailbox = () => {
      if (!mailbox) {
        mailbox = randomId();
        mailboxes.set(mailbox, { ws, expires: Date.now() + MAILBOX_TTL_MS });
      }
      return mailbox;
    };
    send(ws, { type: 'hello', relayKey: publicOnly(relayIdentity.publicJwk), nonce });

    const deliverQueued = () => {
      for (const env of store.queued(me.addr)) send(ws, { type: 'deliver', envelope: env });
    };

    /**
     * Store a sealed envelope for one device. The relay checks who it is *for* (and that the
     * sender knows that account's delivery key), never who it is from.
     */
    function sealedSend(msg, fail, limited) {
      const { to, toDevice, key, id, sealed } = msg;
      if (!isValidHandle(to) || !DEVICE_ID_RE.test(String(toDevice))) return fail('unknown recipient device');
      const list = store.getList(to);
      if (!list || !findDevice(list.payload, toDevice)) return fail('unknown recipient device');
      if (!keyMatches(to, key)) return fail('not allowed');
      if (typeof id !== 'string' || !id || id.length > 64 || !isSealed(sealed)) return fail('bad envelope');
      const addr = deviceAddr(to, toDevice);
      if (limited(limits.sealedTarget, addr, 1, { ref: msg.ref })) return;
      // no sender fields; the relay's own clock instead of the sender's
      const envelope = { id, ts: Date.now(), sealed: { v: 1, ek: publicOnly(sealed.ek), iv: sealed.iv, ct: sealed.ct } };
      const outcome = store.enqueue(addr, envelope, MAX_QUEUE);
      if (outcome === 'full') return fail('recipient queue full');
      const target = online.get(addr);
      if (outcome === 'queued' && target) send(target, { type: 'deliver', envelope });
      return send(ws, { type: 'sealed_ack', ref: msg.ref, queued: !target });
    }

    async function onMessage(msg) {
      const fail = (error, extra = {}) => send(ws, { type: 'error', error, ref: msg.ref, ...extra });
      const limited = (bucket, key, cost = 1, extra = {}) => {
        const wait = bucket.take(key, cost);
        if (wait) fail('rate limited', { retryAfter: wait, ...extra });
        return wait;
      };

      // ----- Cumulus://ID sign-in: started and finished on the same socket -----
      if (msg.type === 'cid_begin' || msg.type === 'cid_finish') {
        if (!cidSvc) return fail('Cumulus://ID is not set up on this relay');
        if (limited(limits.cidIp, ip)) return;
        if (msg.type === 'cid_begin') {
          const purpose = msg.purpose;
          if (!['link', 'restore', 'register'].includes(purpose)) return fail('bad purpose');
          if (purpose === 'link' && !me) return fail('register first');
          try {
            const { state, url } = await cidSvc.begin(ws, purpose);
            return send(ws, { type: 'cid_started', ref: msg.ref, state, url });
          } catch (e) {
            log(`[relay] CID unavailable: ${e.message}`);
            return fail('Cumulus://ID is not reachable right now.');
          }
        }
        let r;
        try { r = await cidSvc.finish(ws, msg.state, msg.code); } catch (e) { return fail(e.message); }
        const who = { email: r.email, name: r.name };
        if (r.purpose === 'link') {
          if (!me) return fail('register first');
          const owner = store.cidHandle(r.key);
          const mine = store.cidOf(me.handle);
          if (owner && owner !== me.handle) return fail('This Cumulus://ID is already linked to another FabriC++ address.');
          if (mine && mine.key !== r.key) return fail('This address is linked to a different Cumulus://ID. Unlink it first.');
          if (!mine) store.linkCid(r.key, me.handle);
          for (const w of socketsOf(me.handle)) send(w, cidStatus(me.handle));
          log(`[relay] ${me.handle} linked a CID`);
          return send(ws, { type: 'cid_done', ref: msg.ref, purpose: 'link', ...who });
        }
        if (r.purpose === 'restore') {
          const handle = store.cidHandle(r.key);
          const info = handle && store.backupInfo(handle);
          return send(ws, { type: 'cid_done', ref: msg.ref, purpose: 'restore', ...who, handle, backup: info ? { ...info, ticket: newTicket('down', handle) } : null });
        }
        // register: remember the proof for this socket's next registration of a new address
        if (store.cidHandle(r.key)) return fail('This Cumulus://ID already has a FabriC++ address. Restore it instead.');
        cidProof = { key: r.key, email: r.email };
        return send(ws, { type: 'cid_done', ref: msg.ref, purpose: 'register', ...who });
      }

      // ----- sealed sender: no registration, so the relay doesn't learn who is sending -----
      if (msg.type === 'sealed_send') {
        const ref = { ref: msg.ref };
        if (limited(limits.sealedIp, ip, 1, ref)) return;
        return sealedSend(msg, fail, limited);
      }
      if (msg.type === 'bundle' && !me) {
        // a contact fetching prekeys anonymously: allowed with the account's delivery key
        if (limited(limits.anonIp, ip)) return;
        const { handle } = parseAddr(String(msg.addr || ''));
        if (!keyMatches(handle, msg.key)) return fail('not allowed');
        const b = bundleFor(`anon:${ip}`, msg.addr);
        return typeof b === 'string' ? fail(b) : send(ws, { type: 'bundle', ref: msg.ref, bundle: b });
      }

      // ----- before registering: lookup (restore and sealed sender need it) and link mailboxes -----
      if (msg.type === 'lookup' || msg.type === 'mailbox_open' || msg.type === 'mailbox_send') {
        const anonBucket = msg.type === 'lookup' ? limits.anonIp : limits.preRegisterIp;
        if (me ? limited(msg.type === 'lookup' ? limits.lookup : limits.mailbox, me.addr) : limited(anonBucket, ip)) return;
        if (msg.type === 'lookup') {
          if (!isValidHandle(msg.handle)) return fail('unknown handle');
          const list = store.getList(msg.handle);
          return list ? send(ws, { type: 'directory', handle: msg.handle, list, ref: msg.ref }) : fail('unknown handle');
        }
        if (msg.type === 'mailbox_open') return send(ws, { type: 'mailbox_id', id: openMailbox(), ref: msg.ref });
        const target = typeof msg.to === 'string' && mailboxes.get(msg.to);
        if (!target || target.expires < Date.now()) return fail('link code expired');
        if (!msg.payload || typeof msg.payload !== 'object') return fail('bad payload');
        send(target.ws, { type: 'mailbox', from: openMailbox(), payload: msg.payload });
        return send(ws, { type: 'mailbox_sent', ref: msg.ref });
      }

      if (msg.type === 'register') {
        if (limited(limits.registerIp, ip)) return;
        const { handle, deviceId, list, proof } = msg;
        if (!isValidHandle(handle) || !DEVICE_ID_RE.test(deviceId || '')) return fail('invalid handle');
        const existing = store.getList(handle);
        let payload;
        try {
          payload = await verifyDeviceList(list, {
            handle, account: existing?.payload.account ?? null, minVersion: existing?.payload.version ?? 0,
          });
        } catch (e) {
          return fail(existing && /account key changed/.test(e.message) ? 'handle taken' : e.message);
        }
        // +scalvs.veil belongs to Scalvs's account key, even while Scalvs is turned off
        if (handle === SCALVS_HANDLE && !isScalvsAccount(bot, payload.account)) return fail('handle reserved');
        // new addresses ending in "bot" belong to bots made with +forgebot (accounts that already exist keep theirs)
        if (!existing && isBotHandle(handle) && !botHub?.mayRegister(handle, payload.account)) return fail('handle reserved');
        const dev = findDevice(payload, deviceId);
        if (!dev) return fail('device not on the account');
        // with FABRIC_CID_REQUIRED=1 a new address needs a CID that has none yet (sybil resistance)
        const needsCid = !existing && cidSvc && cid.required;
        if (needsCid && (!cidProof || store.cidHandle(cidProof.key))) return fail('Sign in with Cumulus://ID first.');
        let expected;
        try { expected = await ownershipProof(relayIdentity.privateJwk, dev.dh, nonce); } catch { return fail('bad key'); }
        if (typeof proof !== 'string' || !timingSafeEqualB64(proof, expected)) return fail('proof failed');

        if (!existing || payload.version > existing.payload.version) applyList(handle, list);
        if (!existing && cidProof && !store.cidHandle(cidProof.key)) store.linkCid(cidProof.key, handle);
        cidProof = null;
        me = { handle, deviceId, addr: deviceAddr(handle, deviceId) };
        online.get(me.addr)?.close(4000, 'signed in elsewhere');
        online.set(me.addr, ws);
        send(ws, { type: 'registered', handle, deviceId, list: store.getList(handle), deliveryKey: deliveryKeyOf(handle) });
        send(ws, accountFor(handle));
        send(ws, { type: 'prekey_count', count: store.opkCount(me.addr), hasSpk: Boolean(store.getSpk(me.addr)) });
        if (cidSvc) send(ws, cidStatus(handle));
        deliverQueued();
        log(`[relay] ${me.addr} online`);
        return;
      }

      if (!me) return fail('register first');
      const myDevice = () => findDevice(store.getList(me.handle).payload, me.deviceId);

      switch (msg.type) {
        case 'send': {
          const e = msg.envelope || {};
          const ref = { ref: e.id, to: e.to, toDevice: e.toDevice };
          if (limited(limits.send, me.addr, 1, ref)) return;
          if (e.from !== me.handle || e.fromDevice !== me.deviceId) return send(ws, { type: 'error', error: 'sender mismatch', ...ref });
          if (!isValidHandle(e.to) || !DEVICE_ID_RE.test(String(e.toDevice))) return send(ws, { type: 'error', error: 'unknown recipient device', ...ref });
          const list = store.getList(e.to);
          if (!list || !findDevice(list.payload, e.toDevice)) return send(ws, { type: 'error', error: 'unknown recipient device', ...ref });
          if (typeof e.id !== 'string' || e.id.length > 64 || !e.header || typeof e.header !== 'object' || typeof e.ct !== 'string') {
            return send(ws, { type: 'error', error: 'bad envelope', ...ref });
          }
          const envelope = {
            id: e.id, from: e.from, fromDevice: e.fromDevice, to: e.to, toDevice: e.toDevice,
            ts: Number(e.ts), header: e.header, ct: e.ct,
          };
          const addr = deviceAddr(e.to, e.toDevice);
          // stored (and committed) before anything is acknowledged; removed when the device acks it
          const outcome = store.enqueue(addr, envelope, MAX_QUEUE);
          if (outcome === 'full') return send(ws, { type: 'error', error: 'recipient queue full', ...ref });
          const target = online.get(addr);
          if (outcome === 'queued') {
            if (target) send(target, { type: 'deliver', envelope });
            if (e.count === true && e.to !== me.handle) { // one count per message, not per device copy
              bump(me.handle, 'usage');
              bump(me.handle, 'network');
            }
          }
          return send(ws, { type: 'ack', id: envelope.id, to: e.to, toDevice: e.toDevice, queued: !target });
        }
        case 'got': {
          // the recipient device has processed (and saved) these envelopes
          const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, 500) : [msg.id];
          for (const id of ids) if (typeof id === 'string') store.ack(me.addr, id);
          return;
        }
        case 'bundle': {
          if (limited(limits.bundle, me.addr)) return;
          const b = bundleFor(me.addr, msg.addr);
          return typeof b === 'string' ? fail(b) : send(ws, { type: 'bundle', ref: msg.ref, bundle: b });
        }
        case 'rotate_delivery_key': {
          // e.g. after spam through sealed sender: contacts holding the old key fall back to
          // ordinary (named) sends until they learn the new one from a message
          if (limited(limits.misc, me.addr)) return;
          const key = newDeliveryKey();
          store.setDeliveryKey(me.handle, key);
          for (const w of socketsOf(me.handle)) send(w, { type: 'delivery_key', key });
          return send(ws, { type: 'delivery_key_rotated', ref: msg.ref });
        }
        case 'tally': {
          // Sealed sends don't say who sent them, so the relay can't count them for revenue share.
          // A device that opted in reports a count now and then instead (capped per day as before).
          if (limited(limits.tally, me.addr)) return;
          const n = Math.floor(Number(msg.n));
          if (!(n > 0 && n <= DAILY_CAPS.usage)) return fail('bad count');
          bump(me.handle, 'usage', n);
          bump(me.handle, 'network', n);
          return;
        }
        case 'upload_prekeys': {
          if (limited(limits.misc, me.addr)) return;
          const { spk, opks = [] } = msg;
          if (spk) {
            if (!(await verifySignedPreKey(myDevice().sig, spk))) return fail('bad signed prekey');
            // the post-quantum half is optional (older clients), but if present it must verify
            if (spk.pq != null && !(await verifyPqPreKey(myDevice().sig, spk))) return fail('bad post-quantum prekey');
            store.setSpk(me.addr, {
              id: Number(spk.id), pub: publicOnly(spk.pub), sig: String(spk.sig),
              ...(spk.pq ? { pq: { pub: String(spk.pq.pub), sig: String(spk.pq.sig) } } : {}),
            });
          }
          const clean = (Array.isArray(opks) ? opks : []).filter((k) => Number.isInteger(k?.id) && isPublicJwk(k.pub)).map((k) => ({ id: k.id, pub: publicOnly(k.pub) }));
          const count = store.addOpks(me.addr, clean, MAX_OPKS);
          return send(ws, { type: 'prekey_count', count, hasSpk: Boolean(store.getSpk(me.addr)) });
        }
        case 'update_devices': {
          if (limited(limits.misc, me.addr)) return;
          const cur = store.getList(me.handle);
          try {
            await verifyDeviceList(msg.list, { handle: me.handle, account: cur.payload.account, minVersion: cur.payload.version + 1 });
          } catch (e) { return fail(e.message); }
          applyList(me.handle, msg.list);
          for (const w of socketsOf(me.handle)) send(w, { type: 'devices', list: msg.list });
          return send(ws, { type: 'devices_updated', ref: msg.ref });
        }
        case 'consent': {
          if (limited(limits.misc, me.addr)) return;
          const next = { ...defaultConsent() };
          for (const k of Object.keys(PURPOSES)) next[k] = Boolean(msg.consent?.[k]);
          store.tx(() => {
            store.setConsent(me.handle, next);
            store.appendLedger({ kind: 'consent', handle: me.handle, consent: next });
          });
          for (const w of socketsOf(me.handle)) send(w, accountFor(me.handle));
          return;
        }
        case 'feature':
          if (limited(limits.misc, me.addr)) return;
          bump(me.handle, 'research');
          return;
        case 'ice': {
          if (limited(limits.misc, me.addr)) return;
          const servers = turn ? [...iceServers, turnCredentials(turn)] : iceServers;
          return send(ws, { type: 'ice', ref: msg.ref, iceServers: servers.map(({ expires, ...s }) => s), expires: turn ? Date.now() + turn.ttl * 1000 : null, sfu: Boolean(sfuSvc) });
        }
        case 'cid_status':
          if (limited(limits.misc, me.addr)) return;
          return send(ws, { ...cidStatus(me.handle), ref: msg.ref });
        case 'cid_unlink': {
          if (limited(limits.misc, me.addr)) return;
          if (!cidSvc) return fail('Cumulus://ID is not set up on this relay');
          store.unlinkCid(me.handle); // the cloud backup goes with it
          for (const w of socketsOf(me.handle)) send(w, cidStatus(me.handle));
          return send(ws, { type: 'cid_unlinked', ref: msg.ref });
        }
        case 'cid_backup_ticket': {
          if (limited(limits.misc, me.addr)) return;
          if (!cidSvc) return fail('Cumulus://ID is not set up on this relay');
          if (!store.cidOf(me.handle)) return fail('Link a Cumulus://ID first.');
          return send(ws, { type: 'cid_backup_ticket', ref: msg.ref, ticket: newTicket('up', me.handle), maxBytes: MAX_BACKUP_BYTES });
        }
        case 'account':
          if (limited(limits.misc, me.addr)) return;
          return send(ws, accountFor(me.handle));
        case 'preview': {
          if (limited(limits.misc, me.addr)) return;
          const revenue = Number(msg.revenue || 0);
          if (!(revenue >= 0 && revenue <= 1e9)) return fail('revenue out of range');
          const { allocations, ...agg } = aggregate(revenue);
          return send(ws, { type: 'preview', ref: msg.ref, ...agg, mineCents: allocations[me.handle] || 0 });
        }
        default:
          if (/^sfu_/.test(String(msg.type))) {
            if (limited(limits.sfu, me.addr)) return;
            if (!sfuSvc) return fail('large calls are not available on this relay');
            const r = await sfuSvc.ws(me.addr, msg);
            if (typeof r === 'string') return fail(r);
            if (r) send(ws, { ...r, ref: msg.ref });
            return;
          }
          if (/^number_/.test(String(msg.type))) {
            if (limited(limits.misc, me.addr)) return;
            if (!linksSvc) return msg.type === 'number_status' ? send(ws, { type: 'number_status', ref: msg.ref, enabled: false }) : fail('linking phone numbers is not available on this relay');
            const reply = (m) => send(ws, { ...m, ref: msg.ref });
            if ((await linksSvc.ws(me, msg, reply, fail)) !== false) return;
          }
          if (/^(phone_|sms_|burner_)/.test(String(msg.type))) {
            if (limited(limits.misc, me.addr)) return;
            if (!phoneSvc) return msg.type === 'phone_status' ? send(ws, { type: 'phone_status', ref: msg.ref, enabled: false }) : fail('phone not configured');
            const reply = (m) => send(ws, { ...m, ref: msg.ref });
            if ((await phoneSvc.ws(me, msg, reply, fail)) !== false) return;
          }
          return fail('unknown type');
      }
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return send(ws, { type: 'error', error: 'bad json' }); }
      if (!msg || typeof msg !== 'object') return send(ws, { type: 'error', error: 'bad json' });
      const wait = limits.message.take(connKey);
      if (wait) {
        send(ws, { type: 'error', error: 'rate limited', retryAfter: wait, ref: msg.ref });
        if (++strikes >= ABUSE_CLOSE_AFTER) ws.close(1008, 'rate limited');
        return;
      }
      onMessage(msg).catch((e) => {
        // a bug or hostile input must cost one request, not the whole relay
        log(`[relay] error handling ${String(msg.type).slice(0, 32)}: ${e.stack || e}`);
        send(ws, { type: 'error', error: 'internal error', ref: msg.ref });
      });
    });

    ws.on('close', () => {
      const n = (socketsPerIp.get(ip) || 1) - 1;
      if (n) socketsPerIp.set(ip, n); else socketsPerIp.delete(ip);
      if (me && online.get(me.addr) === ws) {
        online.delete(me.addr);
        sfuSvc?.gone(me.addr);
      }
      if (mailbox) mailboxes.delete(mailbox);
      cidSvc?.forget(ws);
    });
  });

  await new Promise((r) => server.listen(port, r));
  const actualPort = server.address().port;
  if (cid) {
    const base = (cid.publicUrl || `${tls ? 'https' : 'http'}://localhost:${actualPort}`).replace(/\/$/, '');
    cidSvc = createCid({ ...cid, redirectUri: `${base}/cid-callback.html`, secret: store.secret('cid'), fetchImpl });
    log(`[relay] Cumulus://ID sign-in via ${cid.issuer}${cid.required ? ' (required for new addresses)' : ''}`);
  }
  // Scalvs signs in over loopback like any client (the relay's own certificate, so no CA check)
  const scalvsReady = bot ? bot.start(`${tls ? 'https' : 'http'}://127.0.0.1:${actualPort}`, tls ? { rejectUnauthorized: false } : {}) : null;
  const botsReady = botHub ? botHub.start(`${tls ? 'https' : 'http'}://127.0.0.1:${actualPort}`, tls ? { rejectUnauthorized: false } : {}) : null;
  return {
    port: actualPort,
    url: `${tls ? 'https' : 'http'}://localhost:${actualPort}`,
    store,
    limits,
    settle,
    scalvs: bot,
    scalvsReady,
    bots: botHub,
    botsReady,
    expirePhone: () => phoneSvc?.expire(),
    verifyLedger: () => store.verifyLedger(),
    close: () => new Promise((r) => {
      for (const t of timers) clearInterval(t);
      bot?.stop();
      botHub?.stop();
      sfuSvc?.close();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => { store.close(); r(); });
      server.closeAllConnections?.(); // keep-alive sockets would hold close() open
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const dataFile = process.env.FABRIC_DB || path.join(ROOT, 'data', 'fabric.db');
  const backupCfg = backupFromEnv();
  const backup = backupCfg ? createBackup(backupCfg) : null;
  if (backup) await backup.restoreIfMissing(dataFile); // a fresh host picks up where the last one stopped
  const scalvs = scalvsFromEnv(process.env, dataFile);
  // AI tasks: Claude with an Anthropic key, else an open model on this machine (FABRIC_SCALVS_LOCAL=0: none)
  const scalvsAi = scalvs && (aiFromEnv() || localAiFromEnv(process.env, ROOT));
  const bots = botsFromEnv(process.env, dataFile);
  const relay = await createRelay({ port, dataFile, scalvs: scalvs && { ...scalvs, ai: scalvsAi }, bots });
  console.log(`FABRIC relay listening on ${relay.url}`);
  if (bots) console.log('[relay] Bot API on /bot<token>/<method>; text +forgebot.veil to make a bot');
  if (scalvs) console.log(`[relay] Scalvs runs tasks as +scalvs.veil (AI tasks: ${!scalvsAi ? 'off' : scalvsAi.local ? 'open model on this machine' : scalvsAi.model})`);
  if (backup) {
    await backup.start(relay.store);
    console.log(`[backup] snapshots to Supabase every ${backupCfg.intervalMs / 60_000} min when data changes`);
    const finish = async () => { backup.stop(); await backup.push(relay.store); await relay.close(); process.exit(0); };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  }
  if (!process.env.FABRIC_OPERATOR_TOKEN) console.log('[relay] no FABRIC_OPERATOR_TOKEN: settlement and ledger entries are limited to direct local requests');
}
