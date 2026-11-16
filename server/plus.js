// FabriC++ Plus: plans, entitlements and (test-mode only) checkout.
//
// The relay decides what an account may do from `plus_subs`. A subscription gets there one of
// three ways:
//   - an operator grant (POST /api/plus/grants), for payments taken elsewhere;
//   - a Stripe TEST MODE checkout: the app opens FABRIC_PLUS_CHECKOUT_URL (a buy.stripe.com/test_…
//     Payment Link) with an opaque client_reference_id, and Stripe's signed webhook
//     (POST /api/plus/stripe) grants the plan. Stripe never sees the +name; the relay never sees
//     a card. Events with livemode=true are refused: going live is a deliberate code change;
//   - FABRIC_PAYMENTS=stub: a button in the app grants Plus for 30 days with no payment at all
//     (development and demos).
//
//   FABRIC_PAYMENTS                 off (default) | test | stub. 'live' is refused on purpose.
//   FABRIC_PLUS_CHECKOUT_URL        Stripe test-mode Payment Link (https://buy.stripe.com/test_…)
//   FABRIC_STRIPE_WEBHOOK_SECRET    whsec_… of the test-mode webhook endpoint

import { createHmac, randomBytes } from 'node:crypto';
import { isValidHandle } from '../shared/crypto.js';
import { TIERS, tierOf } from '../shared/tiers.js';

const DAY = 24 * 3600 * 1000;
const CHECKOUT_TTL = DAY;
const STRIPE_TOLERANCE_S = 300;
const TEST_CHECKOUT_RE = /^https:\/\/(buy\.stripe\.com\/test_[A-Za-z0-9]+|checkout\.stripe\.com\/c\/pay\/cs_test_[A-Za-z0-9_#%-]+)$/;

export function paymentsFromEnv(env = process.env, log = console.log) {
  const mode = String(env.FABRIC_PAYMENTS || 'off').toLowerCase();
  if (mode === 'live') {
    log('[plus] FABRIC_PAYMENTS=live is not supported: payments stay off until live mode is built and reviewed');
    return { mode: 'off', checkoutUrl: null, webhookSecret: null };
  }
  if (!['off', 'test', 'stub'].includes(mode)) return { mode: 'off', checkoutUrl: null, webhookSecret: null };
  const url = String(env.FABRIC_PLUS_CHECKOUT_URL || '');
  if (mode === 'test' && url && !TEST_CHECKOUT_RE.test(url)) log('[plus] FABRIC_PLUS_CHECKOUT_URL ignored: only Stripe test-mode links (buy.stripe.com/test_…) are accepted');
  const secret = String(env.FABRIC_STRIPE_WEBHOOK_SECRET || '');
  return {
    mode,
    checkoutUrl: mode === 'test' && TEST_CHECKOUT_RE.test(url) ? url : null,
    webhookSecret: mode === 'test' && /^whsec_[A-Za-z0-9]+$/.test(secret) ? secret : null,
  };
}

/** Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">. */
export function verifyStripeSignature(header, body, secret, now = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > STRIPE_TOLERANCE_S) return false;
  const want = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  return sigs.some((s) => s.length === want.length && createHmac('sha256', 'cmp').update(s).digest('hex') === createHmac('sha256', 'cmp').update(want).digest('hex'));
}

export function createPlus({ store, payments = { mode: 'off' }, log = console.log, now = () => Date.now(), onChange = () => {} }) {
  const db = store.db;
  db.exec(`
CREATE TABLE IF NOT EXISTS plus_subs (handle TEXT PRIMARY KEY, tier TEXT NOT NULL, source TEXT NOT NULL, ref TEXT, sub_id TEXT,
  started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, badge INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS plus_subs_sub ON plus_subs (sub_id);
CREATE TABLE IF NOT EXISTS plus_checkouts (ref TEXT PRIMARY KEY, handle TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plus_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
`);
  const row = (h) => db.prepare('SELECT * FROM plus_subs WHERE handle = ?').get(String(h));

  /** The plan in force for `handle` right now, with its limits. */
  function entitlements(handle) {
    const r = row(handle);
    const active = r && r.expires_at > now() && TIERS[r.tier];
    const t = tierOf(active ? r.tier : 'free');
    return { ...t, tier: t.id, expiresAt: active ? r.expires_at : null, source: active ? r.source : null, showBadge: active ? Boolean(r.badge) : false };
  }

  /** Give `handle` the plan until `until` (extends, never shortens, unless `replace`). */
  function grant(handle, tier, until, { source, ref = null, subId = null, replace = false } = {}) {
    if (!isValidHandle(handle) || !store.getList(handle)) throw Object.assign(new Error('unknown handle'), { status: 400 });
    if (!TIERS[tier]) throw Object.assign(new Error('unknown plan'), { status: 400 });
    const cur = row(handle);
    const expires = replace || !cur || cur.tier !== tier ? until : Math.max(until, cur.expires_at);
    db.prepare(`INSERT INTO plus_subs (handle, tier, source, ref, sub_id, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (handle) DO UPDATE SET tier = excluded.tier, source = excluded.source, ref = excluded.ref,
      sub_id = COALESCE(excluded.sub_id, plus_subs.sub_id), expires_at = excluded.expires_at`)
      .run(handle, tier, source, ref, subId, now(), expires);
    log(`[plus] ${tier} for ${handle} until ${new Date(expires).toISOString()} (${source})`);
    onChange(handle);
    return entitlements(handle);
  }

  function status(handle) {
    return {
      type: 'plus_status', plan: entitlements(handle), payments: payments.mode,
      checkout: payments.mode === 'stub' || Boolean(payments.checkoutUrl),
    };
  }

  /** A link to pay on Stripe (test mode), carrying an opaque reference instead of the +name. */
  function checkoutFor(handle) {
    if (payments.mode === 'stub') return { stub: true };
    if (!payments.checkoutUrl) return null;
    db.prepare('DELETE FROM plus_checkouts WHERE created_at < ?').run(now() - CHECKOUT_TTL);
    const ref = randomBytes(16).toString('base64url');
    db.prepare('INSERT INTO plus_checkouts (ref, handle, created_at) VALUES (?, ?, ?)').run(ref, handle, now());
    const u = new URL(payments.checkoutUrl);
    u.searchParams.set('client_reference_id', ref);
    return { url: u.toString(), testMode: true };
  }

  /** Stripe webhook (test mode). Returns [status, body]. */
  function stripeWebhook(rawBody, signature) {
    if (payments.mode !== 'test' || !payments.webhookSecret) return [404, { error: 'payments are not in test mode' }];
    if (!verifyStripeSignature(signature, rawBody, payments.webhookSecret, now())) return [400, { error: 'bad signature' }];
    let ev;
    try { ev = JSON.parse(rawBody); } catch { return [400, { error: 'bad json' }]; }
    if (ev.livemode !== false) return [400, { error: 'live-mode events are refused: this relay only takes test payments' }];
    if (typeof ev.id !== 'string' || db.prepare('SELECT 1 FROM plus_events WHERE id = ?').get(ev.id)) return [200, { duplicate: true }];
    db.prepare('INSERT INTO plus_events (id, at) VALUES (?, ?)').run(ev.id, now());
    const o = ev.data?.object || {};
    if (ev.type === 'checkout.session.completed') {
      const c = typeof o.client_reference_id === 'string' && db.prepare('SELECT handle FROM plus_checkouts WHERE ref = ?').get(o.client_reference_id);
      if (!c) return [200, { ignored: 'unknown reference' }];
      db.prepare('DELETE FROM plus_checkouts WHERE ref = ?').run(o.client_reference_id);
      grant(c.handle, 'plus', now() + 31 * DAY, { source: 'stripe-test', ref: String(o.id || '').slice(0, 80), subId: typeof o.subscription === 'string' ? o.subscription : null });
      return [200, { granted: true }];
    }
    if (ev.type === 'invoice.paid' && typeof o.subscription === 'string') {
      const r = db.prepare('SELECT handle FROM plus_subs WHERE sub_id = ?').get(o.subscription);
      if (!r) return [200, { ignored: 'unknown subscription' }];
      const end = Number(o.lines?.data?.[0]?.period?.end) * 1000;
      grant(r.handle, 'plus', Number.isFinite(end) && end > now() ? end + DAY : now() + 31 * DAY, { source: 'stripe-test', subId: o.subscription });
      return [200, { renewed: true }];
    }
    if (ev.type === 'customer.subscription.deleted' && typeof o.id === 'string') {
      // the plan runs to the end of what was paid; nothing to do but stop renewing
      return [200, { noted: true }];
    }
    return [200, { ignored: ev.type }];
  }

  function stubActivate(handle) {
    if (payments.mode !== 'stub') return null;
    return grant(handle, 'plus', now() + 30 * DAY, { source: 'stub' });
  }

  function setBadge(handle, show) {
    db.prepare('UPDATE plus_subs SET badge = ? WHERE handle = ?').run(show ? 1 : 0, handle);
    onChange(handle);
  }

  /** Which of these accounts show the Plus mark. Plan details stay private. */
  function badges(handles) {
    return handles.filter((h) => isValidHandle(h)).filter((h) => entitlements(h).showBadge);
  }

  return {
    entitlements, grant, status, checkoutFor, stripeWebhook, stubActivate, setBadge, badges,
    list: (limit = 200) => db.prepare('SELECT handle, tier, source, started_at AS startedAt, expires_at AS expiresAt FROM plus_subs ORDER BY started_at DESC LIMIT ?').all(limit),
    revoke: (handle) => { db.prepare('DELETE FROM plus_subs WHERE handle = ?').run(String(handle)); onChange(handle); },
  };
}
