// Sponsored posts: contextual only, first-party, no ad network.
//
// What an ad may be chosen by:
//   chat list slot      nothing about the person: every free-plan account is eligible alike.
//   public channels     the channel's topic (set by its owner) — the page, not the reader.
// What it is never chosen by: message content (the relay can't read it), contacts, groups,
// private spaces (no ads there at all), activity in other apps, device identifiers.
//
// Frequency cap: the relay counts impressions per account per campaign per UTC day under a
// hash keyed with the day, and deletes those counts when the day ends. Nothing links one day's
// counts to the next, or an account to an advertiser. Advertisers get totals only.
// FabriC++ Plus accounts are never served ads.

import { createHash, randomBytes } from 'node:crypto';
import { TOPICS } from '../shared/spaces.js';

export const PLACEMENTS = ['chatlist', 'channel'];
export const DAILY_PER_ACCOUNT = 8; // all sponsored posts together, per account per day
const day = (t) => new Date(t).toISOString().slice(0, 10);
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, n);
const err = (message, status = 400) => Object.assign(new Error(message), { status });

export function createAds({ store, entitlements, spaces, secret, now = () => Date.now(), log = () => {} }) {
  const db = store.db;
  db.exec(`
CREATE TABLE IF NOT EXISTS ad_campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, advertiser TEXT NOT NULL, headline TEXT NOT NULL,
  body TEXT NOT NULL, url TEXT NOT NULL, cta TEXT NOT NULL, placement TEXT NOT NULL, topics TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'paused', starts_at INTEGER, ends_at INTEGER, max_impressions INTEGER, freq_cap INTEGER NOT NULL DEFAULT 3,
  impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ad_caps (day TEXT NOT NULL, viewer TEXT NOT NULL, campaign TEXT NOT NULL, n INTEGER NOT NULL, clicked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, viewer, campaign));
`);
  const q = (sql) => db.prepare(sql);
  const viewer = (handle, d) => createHash('sha256').update(`${secret}|ads|${d}|${handle}`).digest('base64url').slice(0, 22);
  const row = (id) => q('SELECT * FROM ad_campaigns WHERE id = ?').get(String(id));
  const out = (c) => c && ({
    id: c.id, name: c.name, advertiser: c.advertiser, headline: c.headline, body: c.body, url: c.url, cta: c.cta,
    placement: c.placement, topics: JSON.parse(c.topics), status: c.status, startsAt: c.starts_at, endsAt: c.ends_at,
    maxImpressions: c.max_impressions, freqCap: c.freq_cap, impressions: c.impressions, clicks: c.clicks, createdAt: c.created_at,
  });

  function clean(input, base = {}) {
    const c = { ...base, ...input };
    const v = {
      name: clip(c.name, 80), advertiser: clip(c.advertiser, 40), headline: clip(c.headline, 60), body: clip(c.body, 200),
      url: String(c.url || ''), cta: clip(c.cta || 'Learn more', 20), placement: c.placement,
      topics: Array.isArray(c.topics) ? [...new Set(c.topics)] : [], status: c.status || 'paused',
      startsAt: c.startsAt ?? null, endsAt: c.endsAt ?? null, maxImpressions: c.maxImpressions ?? null, freqCap: c.freqCap ?? 3,
    };
    if (!v.name || !v.advertiser || !v.headline) throw err('name, advertiser and headline are required');
    let u;
    try { u = new URL(v.url); } catch { throw err('url must be an https address'); }
    if (u.protocol !== 'https:' || u.username || u.password) throw err('url must be an https address');
    v.url = u.toString();
    if (!PLACEMENTS.includes(v.placement)) throw err(`placement: ${PLACEMENTS.join(' or ')}`);
    if (v.topics.some((t) => !TOPICS.includes(t))) throw err(`topics from: ${TOPICS.join(', ')}`);
    if (v.placement === 'chatlist' && v.topics.length) throw err('the chat list slot has no topics: it is the same for everyone');
    if (!['active', 'paused', 'ended'].includes(v.status)) throw err('status: active, paused or ended');
    for (const k of ['startsAt', 'endsAt', 'maxImpressions']) if (v[k] !== null && !(Number.isFinite(v[k]) && v[k] > 0)) throw err(`${k}: a positive number or null`);
    if (!(Number.isInteger(v.freqCap) && v.freqCap >= 1 && v.freqCap <= 10)) throw err('freqCap: 1 to 10 per person per day');
    return v;
  }

  function create(input) {
    const v = clean(input);
    const id = randomBytes(9).toString('base64url');
    q(`INSERT INTO ad_campaigns (id, name, advertiser, headline, body, url, cta, placement, topics, status, starts_at, ends_at, max_impressions, freq_cap, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, v.name, v.advertiser, v.headline, v.body, v.url, v.cta, v.placement, JSON.stringify(v.topics), v.status, v.startsAt, v.endsAt, v.maxImpressions, v.freqCap, now());
    log(`[ads] campaign ${id} (${v.placement}) created`);
    return out(row(id));
  }

  function update(id, input) {
    const c = out(row(id));
    if (!c) throw err('unknown campaign', 404);
    const v = clean(input, c);
    q(`UPDATE ad_campaigns SET name = ?, advertiser = ?, headline = ?, body = ?, url = ?, cta = ?, placement = ?, topics = ?, status = ?,
       starts_at = ?, ends_at = ?, max_impressions = ?, freq_cap = ? WHERE id = ?`)
      .run(v.name, v.advertiser, v.headline, v.body, v.url, v.cta, v.placement, JSON.stringify(v.topics), v.status, v.startsAt, v.endsAt, v.maxImpressions, v.freqCap, c.id);
    return out(row(c.id));
  }

  /**
   * One sponsored post for `handle` in `placement`, or { ad: null, reason }. Counting the
   * impression happens here, so the cap holds even if the client misbehaves.
   */
  function serve(handle, { placement, sid } = {}) {
    if (!PLACEMENTS.includes(placement)) throw err('unknown placement');
    if (!entitlements(handle).ads) return { ad: null, reason: 'plus' };
    let topic = null; let channel = null;
    if (placement === 'channel') {
      const s = spaces.space(sid);
      // only public channels: private spaces are encrypted and get no ads at all
      if (!s || s.kind !== 'channel' || s.visibility !== 'public') return { ad: null, reason: 'not a public channel' };
      if (!s.ads) return { ad: null, reason: 'off for this channel' };
      topic = s.topic; channel = s.name;
    }
    const t = now(); const d = day(t); const v = viewer(handle, d);
    q('DELETE FROM ad_caps WHERE day < ?').run(d);
    const today = q('SELECT COALESCE(SUM(n), 0) AS n FROM ad_caps WHERE day = ? AND viewer = ?').get(d, v).n;
    if (today >= DAILY_PER_ACCOUNT) return { ad: null, reason: 'daily cap' };
    const seen = Object.fromEntries(q('SELECT campaign, n FROM ad_caps WHERE day = ? AND viewer = ?').all(d, v).map((r) => [r.campaign, r.n]));
    const eligible = q(`SELECT * FROM ad_campaigns WHERE status = 'active' AND placement = ?
        AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)
        AND (max_impressions IS NULL OR impressions < max_impressions)`).all(placement, t, t)
      .filter((c) => (seen[c.id] || 0) < c.freq_cap)
      .filter((c) => placement === 'chatlist' || JSON.parse(c.topics).length === 0 || JSON.parse(c.topics).includes(topic));
    if (!eligible.length) return { ad: null, reason: 'none eligible' };
    // least-shown first, so a small campaign isn't starved by a large one
    eligible.sort((a, b) => a.impressions - b.impressions || (a.id < b.id ? -1 : 1));
    const c = eligible[0];
    store.tx(() => {
      q('UPDATE ad_campaigns SET impressions = impressions + 1 WHERE id = ?').run(c.id);
      q('INSERT INTO ad_caps (day, viewer, campaign, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, viewer, campaign) DO UPDATE SET n = n + 1').run(d, v, c.id);
    });
    const topics = JSON.parse(c.topics);
    const why = placement === 'chatlist'
      ? ['You are on the free plan, which has one sponsored slot in the chat list.', 'Every free account can see this ad; nothing about you picked it.']
      : [`This is a public channel about ${topic || 'any topic'}${topics.length ? `, and the advertiser chose ${topics.join(', ')}` : ''}.`, `Sponsored posts here depend on the channel (“${channel}”), not on you.`];
    return {
      ad: {
        id: c.id, label: 'Sponsored', advertiser: c.advertiser, headline: c.headline, body: c.body, url: c.url, cta: c.cta, placement,
        why: [...why,
          'Never used: your messages (end-to-end encrypted; the relay can’t read them), contacts, groups, other apps or websites.',
          `You see an ad at most ${c.freq_cap} times a day, and at most ${DAILY_PER_ACCOUNT} sponsored posts a day in total.`,
          'FabriC++ Plus has no ads.'],
      },
    };
  }

  /** A click: counted once per account per campaign per day. No click id goes to the advertiser. */
  function click(handle, id) {
    const c = row(id);
    if (!c) throw err('unknown campaign', 404);
    const d = day(now()); const v = viewer(handle, d);
    const r = q('UPDATE ad_caps SET clicked = 1 WHERE day = ? AND viewer = ? AND campaign = ? AND clicked = 0').run(d, v, c.id);
    if (r.changes) q('UPDATE ad_campaigns SET clicks = clicks + 1 WHERE id = ?').run(c.id);
    return { url: c.url };
  }

  return {
    create, update, serve, click,
    get: (id) => out(row(id)),
    list: () => q('SELECT * FROM ad_campaigns ORDER BY created_at DESC').all().map(out),
  };
}
