// FABRIC Phone: a real phone number per account, through Twilio. Calls to and from ordinary phones
// (in the browser via the Twilio Voice SDK), voicemail, and SMS.
//
// This leaves FABRIC's end-to-end encryption: the phone network carries audio and texts in the
// clear, so Twilio and the carriers can see them, and the relay stores call history and texts
// (30 days) to deliver them to every device. The app says so wherever phone calls appear.
//
// Configuration (all required to turn it on):
//   TWILIO_ACCOUNT_SID     AC…   the account
//   TWILIO_AUTH_TOKEN             checks that webhooks really come from Twilio
//   TWILIO_API_KEY_SID     SK…   signs browser access tokens and calls the REST API
//   TWILIO_API_KEY_SECRET
//   TWILIO_TWIML_APP_SID   AP…   its Voice URL is {FABRIC_PUBLIC_URL}/api/phone/voice
//   FABRIC_PUBLIC_URL             public https URL of this relay, as Twilio sees it
// Optional:
//   FABRIC_PHONE_COUNTRIES        allowed calling-code prefixes for outgoing calls/texts (default +1)
//   FABRIC_PHONE_NUMBERS          JSON {"+15551234567": "@ana.veil"} assigned at start
// Burner numbers (add-on, off until FABRIC_BURNERS=1; see shared/burner.js):
//   FABRIC_BURNERS                1 turns burner numbers on (they are out of the app for now)
//   FABRIC_BURNER_POOL            comma-separated numbers bought for lending out as burners
//   FABRIC_BURNER_COOLDOWN_DAYS   how long a burned number rests before anyone else gets it (default 90)
//   FABRIC_BURNER_CHECKOUT_URL    https page where people buy bundles (shown in the app)
// Each purchased number's Voice URL is {FABRIC_PUBLIC_URL}/api/phone/incoming and its Messaging
// URL is {FABRIC_PUBLIC_URL}/api/phone/sms (both HTTP POST).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isValidHandle } from '../shared/crypto.js';
import { Buckets } from './limits.js';
import { BUNDLES } from '../shared/burner.js';

export const E164_RE = /^\+[1-9]\d{6,14}$/;
export const PHONE_LOG_TTL_MS = 30 * 24 * 3600 * 1000;
const RING_SECONDS = 25;
const VOICEMAIL_SECONDS = 120;
const MAX_SMS = 1600;
const MAX_RECORDING_BYTES = 4 * 1024 * 1024;
const API = 'https://api.twilio.com/2010-04-01';

export function phoneFromEnv(env = process.env) {
  const cfg = {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    apiKey: env.TWILIO_API_KEY_SID,
    apiSecret: env.TWILIO_API_KEY_SECRET,
    appSid: env.TWILIO_TWIML_APP_SID,
    publicUrl: env.FABRIC_PUBLIC_URL?.replace(/\/+$/, ''),
    countries: (env.FABRIC_PHONE_COUNTRIES || '+1').split(',').map((s) => s.trim()).filter(Boolean),
    numbers: {},
    burner: {
      enabled: env.FABRIC_BURNERS === '1',
      pool: (env.FABRIC_BURNER_POOL || '').split(',').map((s) => s.trim()).filter((n) => E164_RE.test(n)),
      cooldownMs: Math.max(0, Number(env.FABRIC_BURNER_COOLDOWN_DAYS ?? 90) || 0) * 86_400_000,
      checkoutUrl: /^https:\/\/[^\s"<>]+$/.test(env.FABRIC_BURNER_CHECKOUT_URL || '') ? env.FABRIC_BURNER_CHECKOUT_URL : null,
    },
  };
  try { cfg.numbers = JSON.parse(env.FABRIC_PHONE_NUMBERS || '{}'); } catch { /* ignored: bad JSON */ }
  const required = ['accountSid', 'authToken', 'apiKey', 'apiSecret', 'appSid', 'publicUrl'];
  return required.every((k) => cfg[k]) ? cfg : null;
}

// ---------- Twilio formats ----------
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A Twilio Access Token (JWT) with a Voice grant for one client identity. */
export function accessToken(cfg, identity, { ttl = 3600, now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${cfg.apiKey}-${iat}`,
    iss: cfg.apiKey,
    sub: cfg.accountSid,
    iat,
    nbf: iat,
    exp: iat + ttl,
    grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: cfg.appSid } } },
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(createHmac('sha256', cfg.apiSecret).update(body).digest())}`;
}

/** Twilio's webhook signature: HMAC-SHA1(url + each POST param name+value, sorted by name). */
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function validSignature(authToken, url, params, signature) {
  if (!signature) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const twiml = (inner = '') => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** A FABRIC handle as a Twilio client identity (letters, digits, underscore) and back. */
export const identityOf = (handle) => handle.replace(/^@/, '').replace(/\.veil$/, '');
export const handleOfIdentity = (id) => {
  const h = `@${String(id).replace(/^client:/, '')}.veil`;
  return isValidHandle(h) ? h : null;
};

export function dialable(number, countries) {
  if (!E164_RE.test(number)) return false;
  if (/^\+1(900|976)/.test(number)) return false; // premium-rate lines
  return countries.some((p) => number.startsWith(p));
}

// ---------- the phone service ----------
/**
 * @param {object} o
 * @param {object} o.cfg       from phoneFromEnv
 * @param {object} o.store     relay store
 * @param {(handle: string, msg: object) => void} o.notify  push to every online device of an account
 * @param {typeof fetch} [o.fetchImpl]
 */
export function createPhone({ cfg, store, notify, log = console.log, fetchImpl = globalThis.fetch }) {
  for (const [number, handle] of Object.entries(cfg.numbers || {})) {
    if (E164_RE.test(number) && isValidHandle(handle)) store.assignNumber(number, handle);
  }
  const burnerCfg = { enabled: false, pool: [], cooldownMs: 90 * 86_400_000, checkoutUrl: null, ...cfg.burner };
  if (burnerCfg.enabled) for (const n of burnerCfg.pool) store.addToPool(n);
  const buckets = {
    token: new Buckets(10, 10 / 60),        // access tokens per device
    call: new Buckets(10, 30 / 3600),       // outgoing calls per account: 10 at once, 30 an hour
    sms: new Buckets(20, 60 / 3600),        // texts per account
    fetchVm: new Buckets(10, 30 / 60),
    burner: new Buckets(6, 12 / 86400),      // new burner numbers per account: 6 at once, 12 a day
  };

  /** What a device needs to show: main number, burner lines and bundles, and what's on offer. */
  function status(handle) {
    return {
      type: 'phone_status', enabled: true, number: store.numberOf(handle), countries: cfg.countries,
      ...(burnerCfg.enabled ? {
        burners: {
          lines: store.burnerLines(handle), slots: store.burnerSlots(handle), bundles: store.burnerBundles(handle),
          available: store.poolHasFree(), checkoutUrl: burnerCfg.checkoutUrl, bundleSizes: BUNDLES,
        },
      } : {}),
    };
  }
  const pushStatus = (handle) => notify(handle, status(handle));
  /** The number an account calls or texts from: a burner it owns, or its main number. */
  const fromNumber = (handle, via) => (via ? (burnerCfg.enabled && store.ownsLine(handle, via) ? via : null) : store.numberOf(handle));
  const canCall = (handle) => Boolean(store.numberOf(handle) || (burnerCfg.enabled && store.burnerLines(handle).length));
  const burnNow = (handle, number) => store.burnLine(handle, number, Date.now() + burnerCfg.cooldownMs);
  const auth = 'Basic ' + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64');

  function record(handle, event) {
    const e = store.addPhoneEvent(handle, event);
    notify(handle, { type: 'phone_event', event: e });
    return e;
  }

  async function readForm(req, max = 20_000) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > max) throw Object.assign(new Error('body too large'), { status: 413 });
    }
    return Object.fromEntries(new URLSearchParams(body));
  }

  // ---------- webhooks (Twilio → relay) ----------
  const ROUTES = new Set(['/api/phone/voice', '/api/phone/incoming', '/api/phone/missed', '/api/phone/recording', '/api/phone/sms']);

  /** Returns true if it handled the request. */
  async function http(req, res, url) {
    if (!ROUTES.has(url.pathname)) return false;
    const xml = (body, code = 200) => { res.writeHead(code, { 'content-type': 'text/xml', 'cache-control': 'no-store' }); res.end(body); };
    if (req.method !== 'POST') { xml(twiml(), 405); return true; }
    const params = await readForm(req);
    const full = cfg.publicUrl + url.pathname + url.search;
    if (!validSignature(cfg.authToken, full, params, req.headers['x-twilio-signature'])) {
      log(`[phone] rejected unsigned webhook ${url.pathname}`);
      xml(twiml(), 403);
      return true;
    }
    xml(await webhook(url, params));
    return true;
  }

  async function webhook(url, p) {
    const at = (path, q = {}) => esc(`${cfg.publicUrl}${path}?${new URLSearchParams(q)}`);
    switch (url.pathname) {
      case '/api/phone/voice': {
        // a FABRIC user dialing out from the browser
        const handle = handleOfIdentity(p.From || '');
        const via = E164_RE.test(p.Via || '') ? p.Via : null;
        const number = handle && fromNumber(handle, via);
        const to = String(p.To || '').replace(/[^\d+]/g, '');
        if (!number) return twiml(via ? '<Say>That burner number is no longer yours.</Say><Hangup/>' : '<Say>This FABRIC account has no phone number.</Say><Hangup/>');
        if (!dialable(to, cfg.countries)) return twiml('<Say>That number cannot be called from FABRIC.</Say><Hangup/>');
        if (buckets.call.take(handle)) return twiml('<Say>Too many calls. Please try again later.</Say><Hangup/>');
        record(handle, { kind: 'call', dir: 'out', peer: to, callSid: p.CallSid, status: 'dialing', ...(via ? { via } : {}) });
        return twiml(`<Dial callerId="${esc(number)}" answerOnBridge="true" timeLimit="14400"><Number>${esc(to)}</Number></Dial>`);
      }
      case '/api/phone/incoming': {
        const owner = store.ownerOfNumber(p.To);
        if (!owner) return twiml('<Say>The number you have called is not in service.</Say><Hangup/>');
        const { handle } = owner;
        const via = owner.burner ? p.To : null;
        const from = E164_RE.test(p.From || '') ? p.From : 'unknown';
        record(handle, { kind: 'call', dir: 'in', peer: from, callSid: p.CallSid, status: 'ringing', ...(via ? { via } : {}) });
        return twiml(
          `<Dial timeout="${RING_SECONDS}" action="${at('/api/phone/missed', { n: p.To })}">`
          + `<Client><Identity>${esc(identityOf(handle))}</Identity><Parameter name="from" value="${esc(from)}"/>${via ? `<Parameter name="via" value="${esc(via)}"/>` : ''}</Client></Dial>`,
        );
      }
      case '/api/phone/missed': {
        // the <Dial> above finished: answered, or time for voicemail
        const n = url.searchParams.get('n');
        const owner = store.ownerOfNumber(n);
        const handle = owner?.handle;
        if (!handle || p.DialCallStatus === 'completed' || p.DialCallStatus === 'answered') return twiml('<Hangup/>');
        record(handle, { kind: 'missed', dir: 'in', peer: E164_RE.test(p.From || '') ? p.From : 'unknown', callSid: p.CallSid, ...(owner.burner ? { via: n } : {}) });
        return twiml(
          '<Say>The person you are calling is not available. Leave a message after the tone.</Say>'
          + `<Record maxLength="${VOICEMAIL_SECONDS}" playBeep="true" recordingStatusCallback="${at('/api/phone/recording', { n: url.searchParams.get('n') })}"/>`
          + '<Say>No message was recorded. Goodbye.</Say>',
        );
      }
      case '/api/phone/recording': {
        const n = url.searchParams.get('n');
        const owner = store.ownerOfNumber(n);
        const handle = owner?.handle;
        if (!handle || p.RecordingStatus !== 'completed' || !/^RE[0-9a-f]{32}$/i.test(p.RecordingSid || '')) return twiml();
        const call = p.CallSid && store.callOwner(p.CallSid);
        const peer = call ? JSON.parse(call.event).peer : 'unknown';
        record(handle, { kind: 'voicemail', dir: 'in', peer, recording: p.RecordingSid, seconds: Number(p.RecordingDuration) || 0, ...(owner.burner ? { via: n } : {}) });
        return twiml();
      }
      case '/api/phone/sms': {
        const owner = store.ownerOfNumber(p.To);
        if (owner) record(owner.handle, { kind: 'sms', dir: 'in', peer: E164_RE.test(p.From || '') ? p.From : 'unknown', text: String(p.Body || '').slice(0, MAX_SMS), ...(owner.burner ? { via: p.To } : {}) });
        return twiml();
      }
    }
    return twiml();
  }

  // ---------- client messages (over the user's authenticated socket) ----------
  async function ws(me, msg, reply, fail) {
    switch (msg.type) {
      case 'phone_status':
        return reply(status(me.handle));
      case 'phone_token': {
        if (!canCall(me.handle)) return fail('no phone number on this account');
        if (buckets.token.take(me.addr)) return fail('rate limited');
        return reply({ type: 'phone_token', token: accessToken(cfg, identityOf(me.handle)), identity: identityOf(me.handle) });
      }
      case 'phone_log':
        return reply({ type: 'phone_log', events: store.phoneLog(me.handle) });
      case 'sms_send': {
        const via = msg.via ? String(msg.via) : null;
        const number = fromNumber(me.handle, via);
        const to = String(msg.to || '').replace(/[^\d+]/g, '');
        const text = String(msg.text || '');
        if (!number) return fail(via ? 'that burner number is no longer yours' : 'no phone number on this account');
        if (!dialable(to, cfg.countries)) return fail('that number cannot be texted from FABRIC');
        if (!text.trim() || text.length > MAX_SMS) return fail(`texts are 1–${MAX_SMS} characters`);
        if (buckets.sms.take(me.handle)) return fail('rate limited');
        const r = await fetchImpl(`${API}/Accounts/${cfg.accountSid}/Messages.json`, {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: number, To: to, Body: text }),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) return fail(`carrier refused the text: ${String(out.message || r.status).slice(0, 200)}`);
        const e = record(me.handle, { kind: 'sms', dir: 'out', peer: to, text, sid: out.sid, ...(via ? { via } : {}) });
        return reply({ type: 'sms_sent', event: e });
      }
      case 'phone_voicemail': {
        const e = store.phoneEvent(me.handle, msg.seq);
        if (!e || e.kind !== 'voicemail') return fail('no such voicemail');
        if (buckets.fetchVm.take(me.addr)) return fail('rate limited');
        const r = await fetchImpl(`${API}/Accounts/${cfg.accountSid}/Recordings/${e.recording}.mp3`, { headers: { authorization: auth } });
        if (!r.ok) return fail('recording unavailable');
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_RECORDING_BYTES) return fail('recording too large');
        return reply({ type: 'phone_voicemail', seq: e.seq, mime: 'audio/mpeg', audio: buf.toString('base64') });
      }
      // ----- burner numbers -----
      case 'burner_create': {
        if (!burnerCfg.enabled) return fail('burner numbers are not available');
        if (store.burnerLines(me.handle).length >= store.burnerSlots(me.handle)) return fail('no free burner slots: add a bundle first');
        if (!store.poolHasFree()) return fail('no numbers are free right now; try again later');
        if (buckets.burner.take(me.handle)) return fail('too many new numbers today');
        const number = store.takeLine(me.handle);
        if (!number) return fail('no numbers are free right now; try again later');
        pushStatus(me.handle);
        return reply({ ...status(me.handle), type: 'burner_created', line: number });
      }
      case 'burner_burn': {
        if (!burnerCfg.enabled) return fail('burner numbers are not available');
        const number = String(msg.number || '');
        if (!burnNow(me.handle, number)) return fail('that number is not one of your burners');
        pushStatus(me.handle);
        return reply({ ...status(me.handle), type: 'burner_burned', line: number });
      }
      case 'burner_rotate': {
        if (!burnerCfg.enabled) return fail('burner numbers are not available');
        // a fresh number in place of this one, in one step: the old one only goes if a new one comes
        const old = String(msg.number || '');
        if (!store.ownsLine(me.handle, old)) return fail('that number is not one of your burners');
        if (!store.poolHasFree()) return fail('no numbers are free right now; try again later');
        if (buckets.burner.take(me.handle)) return fail('too many new numbers today');
        let number = null;
        store.tx(() => {
          number = store.takeLine(me.handle, Date.now(), old);
          if (number) burnNow(me.handle, old);
        });
        if (!number) return fail('no numbers are free right now; try again later');
        pushStatus(me.handle);
        return reply({ ...status(me.handle), type: 'burner_rotated', old, line: number });
      }
      default:
        return false;
    }
  }

  /** Daily: forget old history; when a bundle runs out, its newest lines are burned. */
  function expire() {
    const n = store.expirePhoneLog(Date.now() - PHONE_LOG_TTL_MS);
    const touched = new Set();
    for (const { handle, number } of store.excessLines()) { if (burnNow(handle, number)) touched.add(handle); }
    for (const h of touched) pushStatus(h);
    return n;
  }

  /** Operator: record a bundle someone bought (payment happens elsewhere). */
  function grant({ handle, size, period, id, expiresAt }) {
    if (!BUNDLES.includes(size) || !['month', 'year'].includes(period)) throw Object.assign(new Error('bundles are 1, 2 or 5 numbers, per month or year'), { status: 400 });
    const until = Number.isFinite(expiresAt) ? expiresAt : Date.now() + (period === 'year' ? 366 : 31) * 86_400_000;
    store.grantBundle({ id, handle, size, period, expiresAt: until });
    pushStatus(handle);
    return { id, handle, size, period, expiresAt: until };
  }

  return { http, ws, expire, grant, status, pushStatus, burnersEnabled: burnerCfg.enabled };
}
