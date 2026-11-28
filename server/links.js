// Linked phone numbers: someone proves they receive texts at a number and ties it to their account,
// so FabriC++ users who dial or text that number can reach them end-to-end encrypted instead.
//
// The relay never stores the number: only HMAC(pepper, number). A leaked database alone does not
// list anyone's number. Discovery is opt-in per account and rate-limited, because the space of
// phone numbers is small enough to walk.
//
// Environment:
//   FABRIC_NUMBER_PEPPER          32+ characters; keys the HMAC (keep it out of the database)
//   TWILIO_VERIFY_SERVICE_SID     Twilio Verify service that texts and checks the codes, with
//   TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET (or TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)
//   FABRIC_LINK_COUNTRIES         calling codes allowed, default +1 (FABRIC_PHONE_COUNTRIES if set)
//   FABRIC_NUMBER_VERIFY=dev      development only: codes are written to the relay log instead of
//                                 texted. The relay refuses this unless every origin is localhost.

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Buckets } from './limits.js';

export const E164_RE = /^\+[1-9]\d{6,14}$/;
export const LINK_TTL_MS = 365 * 86_400_000;      // re-verify yearly: carriers recycle numbers
export const MAX_LOOKUP = 50;                      // numbers per lookup request
export const CODE_RE = /^\d{4,10}$/;
const MAX_WRONG = 5;                               // wrong codes before an attempt is void
const PENDING_TTL_MS = 10 * 60_000;

export const numberMac = (pepper, number) => createHmac('sha256', pepper).update(`fabric-number|${number}`).digest('base64url');

export function linksFromEnv(env = process.env) {
  const pepper = env.FABRIC_NUMBER_PEPPER || '';
  const countries = (env.FABRIC_LINK_COUNTRIES || env.FABRIC_PHONE_COUNTRIES || '+1').split(',').map((s) => s.trim()).filter((c) => /^\+\d{1,3}$/.test(c));
  if (env.FABRIC_NUMBER_VERIFY === 'dev') return { mode: 'dev', pepper: pepper || null, countries };
  const user = env.TWILIO_API_KEY_SID || env.TWILIO_ACCOUNT_SID;
  const pass = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN;
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
  if (!(serviceSid && user && pass && pepper.length >= 32)) return null;
  return { mode: 'twilio', pepper, countries, serviceSid, user, pass };
}

/** Texts and checks codes through Twilio Verify; we never see or store the code. */
export function twilioVerifier({ serviceSid, user, pass, fetchImpl = globalThis.fetch }) {
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const post = async (path, form) => {
    const r = await fetchImpl(`https://verify.twilio.com/v2/Services/${serviceSid}/${path}`, {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  };
  return {
    async start(number) {
      const r = await post('Verifications', { To: number, Channel: 'sms' });
      if (!r.ok) throw Object.assign(new Error(r.status === 429 ? 'too many codes for this number; try later' : 'could not send the code'), { status: r.status });
    },
    async check(number, code) {
      const r = await post('VerificationCheck', { To: number, Code: code });
      if (r.status === 404) return false; // expired or already used
      if (!r.ok) throw new Error('could not check the code');
      return r.body.status === 'approved';
    },
  };
}

/** Development: the code goes to the relay log. Never texted, never in production. */
export function devVerifier(log = console.log) {
  const codes = new Map();
  return {
    async start(number) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      codes.set(number, { code, expires: Date.now() + PENDING_TTL_MS });
      log(`[dev] verification code for ${number}: ${code}`);
    },
    async check(number, code) {
      const c = codes.get(number);
      if (!c || c.expires < Date.now()) return false;
      const a = Buffer.from(c.code); const b = Buffer.from(String(code));
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (ok) codes.delete(number);
      return ok;
    },
    peek: (number) => codes.get(number)?.code, // tests
  };
}

/**
 * @param {object} o
 * @param {object} o.cfg       from linksFromEnv
 * @param {object} o.store     relay store
 * @param {(handle: string, msg: object) => void} o.notify
 * @param {{start: Function, check: Function}} [o.verifier]
 */
export function createLinks({ cfg, store, notify, log = console.log, fetchImpl = globalThis.fetch, verifier, now = () => Date.now() }) {
  const pepper = cfg.pepper || store.secret('number-pepper'); // dev only: a pepper kept beside the data
  verifier ??= cfg.mode === 'dev' ? devVerifier(log) : twilioVerifier({ ...cfg, fetchImpl });
  const mac = (number) => numberMac(pepper, number);
  const limits = {
    codeHour: new Buckets(3, 3 / 3600, { now }),       // code requests per account: 3 an hour
    codeDay: new Buckets(10, 10 / 86400, { now }),     // and 10 a day
    perNumber: new Buckets(1, 1 / 120, { now }),       // per number: one text, then 2 minutes' rest
    lookups: new Buckets(200, 200 / 86400, { now }),   // numbers looked up per account per day
  };
  const pending = new Map(); // handle -> { mac, number, wrong, expires }

  const allowedNumber = (n) => typeof n === 'string' && E164_RE.test(n) && cfg.countries.some((c) => n.startsWith(c));
  const live = (row) => row && now() - row.verifiedAt < LINK_TTL_MS;

  function status(handle) {
    const row = store.numberLinkOf(handle);
    return {
      type: 'number_status', enabled: true, countries: cfg.countries,
      linked: row ? { verifiedAt: row.verifiedAt, expiresAt: row.verifiedAt + LINK_TTL_MS, expired: !live(row), discoverable: row.discoverable } : null,
    };
  }

  async function ws(me, msg, reply, fail) {
    switch (msg.type) {
      case 'number_status':
        return reply(status(me.handle));

      case 'number_verify_start': {
        const number = String(msg.number || '');
        if (!allowedNumber(number)) return fail(`use a full number starting with ${cfg.countries.join(' or ')}`);
        const m = mac(number);
        if (limits.codeHour.take(me.handle) || limits.codeDay.take(me.handle)) return fail('too many codes requested; try again later');
        if (limits.perNumber.take(m)) return fail('a code was just sent to this number; wait 2 minutes');
        try {
          await verifier.start(number);
        } catch (e) {
          log('number verify start failed:', e.message);
          return fail(e.message || 'could not send the code');
        }
        pending.set(me.handle, { mac: m, number, wrong: 0, expires: now() + PENDING_TTL_MS });
        return reply({ type: 'number_code_sent' });
      }

      case 'number_verify_check': {
        const p = pending.get(me.handle);
        const code = String(msg.code || '').trim();
        if (!p || p.expires < now()) { pending.delete(me.handle); return fail('the code expired; send a new one'); }
        if (!CODE_RE.test(code)) return fail('enter the code from the text');
        let ok = false;
        try { ok = await verifier.check(p.number, code); } catch (e) { return fail(e.message); }
        if (!ok) {
          if (++p.wrong >= MAX_WRONG) { pending.delete(me.handle); return fail('too many wrong codes; send a new one'); }
          return fail(`wrong code (${MAX_WRONG - p.wrong} tries left)`);
        }
        pending.delete(me.handle);
        const before = store.numberLinkOf(me.handle);
        const prev = store.linkNumber(p.mac, me.handle, now(), before?.discoverable ?? false);
        // a recycled number: whoever had it before loses the link, and is told
        if (prev && prev !== me.handle) notify(prev, { ...status(prev), reason: 'claimed' });
        notify(me.handle, status(me.handle)); // the account's other devices
        return reply({ ...status(me.handle), type: 'number_linked' });
      }

      case 'number_unlink':
        pending.delete(me.handle);
        store.unlinkNumber(me.handle);
        notify(me.handle, status(me.handle));
        return reply(status(me.handle));

      case 'number_discoverable': {
        if (!store.numberLinkOf(me.handle)) return fail('link a number first');
        store.setNumberDiscoverable(me.handle, msg.on === true);
        notify(me.handle, status(me.handle));
        return reply(status(me.handle));
      }

      case 'number_lookup': {
        const list = Array.isArray(msg.numbers) ? [...new Set(msg.numbers.map(String))] : [];
        if (!list.length || list.length > MAX_LOOKUP) return fail(`look up 1 to ${MAX_LOOKUP} numbers at a time`);
        const wait = limits.lookups.take(me.handle, list.length);
        if (wait) return fail('too many lookups today; try again later');
        const results = {};
        for (const n of list) {
          if (!E164_RE.test(n)) { results[n] = null; continue; }
          const row = store.numberLinkByMac(mac(n));
          // not linked, not opted in, or lapsed: all read the same, so a lookup can't tell them apart
          results[n] = live(row) && row.discoverable ? row.handle : null;
        }
        return reply({ type: 'number_lookup', results });
      }

      default:
        return false;
    }
  }

  return { ws, status, verifier };
}
