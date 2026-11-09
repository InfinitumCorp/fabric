// FABRIC relay storage: SQLite (node:sqlite), WAL journal, synchronous=FULL.
// Every write that the relay acknowledges to a client is committed before the ack is sent.
// The relay stores only public keys, signed device lists, ciphertext envelopes, consent,
// metadata counters, balances and the settlement ledger.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const GENESIS = '0'.repeat(64);
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (handle TEXT PRIMARY KEY, list TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spks (addr TEXT PRIMARY KEY, spk TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS opks (addr TEXT NOT NULL, id INTEGER NOT NULL, pub TEXT NOT NULL, PRIMARY KEY (addr, id));
CREATE TABLE IF NOT EXISTS queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, addr TEXT NOT NULL, id TEXT NOT NULL,
  envelope TEXT NOT NULL, queued_at INTEGER NOT NULL, UNIQUE (addr, id));
CREATE INDEX IF NOT EXISTS queue_addr ON queue (addr, seq);
CREATE INDEX IF NOT EXISTS queue_age ON queue (queued_at);
CREATE TABLE IF NOT EXISTS consent (handle TEXT PRIMARY KEY, consent TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (handle TEXT NOT NULL, purpose TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (handle, purpose));
CREATE TABLE IF NOT EXISTS daily (handle TEXT NOT NULL, purpose TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (handle, purpose, day));
CREATE TABLE IF NOT EXISTS balances (handle TEXT PRIMARY KEY, fab REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, handle TEXT, body TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_handle ON ledger (handle, kind, seq);
CREATE TABLE IF NOT EXISTS payouts (handle TEXT NOT NULL, seq INTEGER NOT NULL, cents INTEGER NOT NULL, fab REAL NOT NULL, PRIMARY KEY (handle, seq));
CREATE TABLE IF NOT EXISTS delivery_keys (handle TEXT PRIMARY KEY, key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phone_numbers (number TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS phone_log (seq INTEGER PRIMARY KEY, handle TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL, call_sid TEXT);
CREATE INDEX IF NOT EXISTS phone_log_handle ON phone_log (handle, seq);
CREATE INDEX IF NOT EXISTS phone_log_call ON phone_log (call_sid);
CREATE TABLE IF NOT EXISTS burner_pool (number TEXT PRIMARY KEY, free_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS burner_lines (number TEXT PRIMARY KEY, handle TEXT NOT NULL, created_at INTEGER NOT NULL, rotated_from TEXT);
CREATE INDEX IF NOT EXISTS burner_lines_handle ON burner_lines (handle);
CREATE TABLE IF NOT EXISTS burner_bundles (id TEXT PRIMARY KEY, handle TEXT NOT NULL, size INTEGER NOT NULL, period TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS burner_bundles_handle ON burner_bundles (handle);
CREATE TABLE IF NOT EXISTS cid_links (key TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, linked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_backups (handle TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS phone_links (number_mac TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, verified_at INTEGER NOT NULL, discoverable INTEGER NOT NULL DEFAULT 0);
`;

const linkRow = (r) => (r ? { mac: r.number_mac, handle: r.handle, verifiedAt: r.verified_at, discoverable: Boolean(r.discoverable) } : null);

export function openStore(file = null, { importJson = null } = {}) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file || ':memory:');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value;
  if (!version) db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));

  const q = (sql) => db.prepare(sql);
  const st = {
    getAccount: q('SELECT list FROM accounts WHERE handle = ?'),
    putAccount: q('INSERT INTO accounts (handle, list, version) VALUES (?, ?, ?) ON CONFLICT (handle) DO UPDATE SET list = excluded.list, version = excluded.version'),
    handles: q('SELECT handle FROM accounts'),
    getSpk: q('SELECT spk FROM spks WHERE addr = ?'),
    setSpk: q('INSERT INTO spks (addr, spk) VALUES (?, ?) ON CONFLICT (addr) DO UPDATE SET spk = excluded.spk'),
    opkCount: q('SELECT COUNT(*) AS n FROM opks WHERE addr = ?'),
    addOpk: q('INSERT OR IGNORE INTO opks (addr, id, pub) VALUES (?, ?, ?)'),
    firstOpk: q('SELECT id, pub FROM opks WHERE addr = ? ORDER BY id LIMIT 1'),
    delOpk: q('DELETE FROM opks WHERE addr = ? AND id = ?'),
    delSpk: q('DELETE FROM spks WHERE addr = ?'),
    delOpks: q('DELETE FROM opks WHERE addr = ?'),
    delQueue: q('DELETE FROM queue WHERE addr = ?'),
    enqueue: q('INSERT OR IGNORE INTO queue (addr, id, envelope, queued_at) VALUES (?, ?, ?, ?)'),
    queueCount: q('SELECT COUNT(*) AS n FROM queue WHERE addr = ?'),
    queued: q('SELECT envelope FROM queue WHERE addr = ? ORDER BY seq LIMIT ?'),
    ack: q('DELETE FROM queue WHERE addr = ? AND id = ?'),
    expire: q('DELETE FROM queue WHERE queued_at < ?'),
    getConsent: q('SELECT consent FROM consent WHERE handle = ?'),
    setConsent: q('INSERT INTO consent (handle, consent) VALUES (?, ?) ON CONFLICT (handle) DO UPDATE SET consent = excluded.consent'),
    counters: q('SELECT purpose, n FROM counters WHERE handle = ?'),
    bump: q('INSERT INTO counters (handle, purpose, n) VALUES (?, ?, ?) ON CONFLICT (handle, purpose) DO UPDATE SET n = n + excluded.n'),
    daily: q('SELECT n FROM daily WHERE handle = ? AND purpose = ? AND day = ?'),
    bumpDaily: q('INSERT INTO daily (handle, purpose, day, n) VALUES (?, ?, ?, ?) ON CONFLICT (handle, purpose, day) DO UPDATE SET n = n + excluded.n'),
    pruneDaily: q('DELETE FROM daily WHERE day < ?'),
    balance: q('SELECT fab FROM balances WHERE handle = ?'),
    credit: q('INSERT INTO balances (handle, fab) VALUES (?, ?) ON CONFLICT (handle) DO UPDATE SET fab = fab + excluded.fab'),
    ledgerHead: q('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1'),
    ledgerAdd: q('INSERT INTO ledger (seq, kind, handle, body, hash) VALUES (?, ?, ?, ?, ?)'),
    ledgerAll: q('SELECT seq, body, hash FROM ledger ORDER BY seq'),
    ledgerRecent: q('SELECT body, hash FROM ledger ORDER BY seq DESC LIMIT ?'),
    receipts: q("SELECT body, hash FROM ledger WHERE handle = ? AND kind = 'consent' ORDER BY seq DESC LIMIT ?"),
    payoutAdd: q('INSERT INTO payouts (handle, seq, cents, fab) VALUES (?, ?, ?, ?)'),
    payouts: q('SELECT p.seq, p.cents, p.fab, l.body, l.hash FROM payouts p JOIN ledger l ON l.seq = p.seq WHERE p.handle = ? ORDER BY p.seq DESC LIMIT ?'),
    count: (t) => q(`SELECT COUNT(*) AS n FROM ${t}`),
  };

  let depth = 0;
  /** Run fn in one transaction (nested calls join the outer one). */
  function tx(fn) {
    if (depth) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  }

  const parse = (row, col) => (row ? JSON.parse(row[col]) : null);
  const entryOf = (row) => ({ ...JSON.parse(row.body), hash: row.hash });

  const store = {
    db,
    file,
    tx,
    close: () => db.close(),

    // ----- accounts -----
    getList: (handle) => parse(st.getAccount.get(String(handle)), 'list'),
    putList: (handle, list) => st.putAccount.run(handle, JSON.stringify(list), list.payload.version),
    handles: () => st.handles.all().map((r) => r.handle),

    // ----- sealed sender: who may deliver to an account without saying who they are -----
    // ----- Cumulus://ID: key = HMAC(relay secret, issuer|sub), never CID's own id -----
    secret: (name) => {
      const k = `secret:${name}`;
      let v = db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
      if (!v) { v = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url'); db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(k, v); }
      return v;
    },
    cidHandle: (key) => db.prepare('SELECT handle FROM cid_links WHERE key = ?').get(String(key))?.handle || null,
    cidOf: (handle) => db.prepare('SELECT key, linked_at AS linkedAt FROM cid_links WHERE handle = ?').get(String(handle)) || null,
    linkCid: (key, handle, at = Date.now()) => db.prepare('INSERT INTO cid_links (key, handle, linked_at) VALUES (?, ?, ?)').run(String(key), String(handle), at),
    unlinkCid: (handle) => {
      db.prepare('DELETE FROM cid_links WHERE handle = ?').run(String(handle));
      db.prepare('DELETE FROM cloud_backups WHERE handle = ?').run(String(handle));
    },
    putBackup: (handle, blob, at = Date.now()) => db.prepare('INSERT INTO cloud_backups (handle, blob, updated_at) VALUES (?, ?, ?) ON CONFLICT (handle) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at').run(String(handle), blob, at),
    backupInfo: (handle) => db.prepare('SELECT length(blob) AS size, updated_at AS updatedAt FROM cloud_backups WHERE handle = ?').get(String(handle)) || null,
    getBackup: (handle) => db.prepare('SELECT blob FROM cloud_backups WHERE handle = ?').get(String(handle))?.blob || null,
    getDeliveryKey: (handle) => db.prepare('SELECT key FROM delivery_keys WHERE handle = ?').get(String(handle))?.key || null,
    setDeliveryKey: (handle, key) => db.prepare('INSERT INTO delivery_keys (handle, key) VALUES (?, ?) ON CONFLICT (handle) DO UPDATE SET key = excluded.key').run(String(handle), key),

    // ----- prekeys -----
    getSpk: (addr) => parse(st.getSpk.get(addr), 'spk'),
    setSpk: (addr, spk) => st.setSpk.run(addr, JSON.stringify(spk)),
    opkCount: (addr) => st.opkCount.get(addr).n,
    addOpks(addr, opks, max) {
      return tx(() => {
        let n = store.opkCount(addr);
        for (const k of opks) {
          if (n >= max) break;
          if (st.addOpk.run(addr, k.id, JSON.stringify(k.pub)).changes) n++;
        }
        return n;
      });
    },
    popOpk(addr) {
      return tx(() => {
        const row = st.firstOpk.get(addr);
        if (!row) return null;
        st.delOpk.run(addr, row.id);
        return { id: row.id, pub: JSON.parse(row.pub) };
      });
    },
    dropDevice(addr) {
      tx(() => { st.delSpk.run(addr); st.delOpks.run(addr); st.delQueue.run(addr); });
    },

    // ----- store-until-acknowledged delivery -----
    /** Returns 'queued', 'duplicate' or 'full'. */
    enqueue(addr, envelope, max, now = Date.now()) {
      return tx(() => {
        if (st.queueCount.get(addr).n >= max) return 'full';
        return st.enqueue.run(addr, envelope.id, JSON.stringify(envelope), now).changes ? 'queued' : 'duplicate';
      });
    },
    queued: (addr, limit = 1000) => st.queued.all(addr, limit).map((r) => JSON.parse(r.envelope)),
    queueCount: (addr) => st.queueCount.get(addr).n,
    ack: (addr, id) => st.ack.run(addr, id).changes,
    expireQueues: (before) => st.expire.run(before).changes,

    // ----- economy -----
    getConsent: (handle) => parse(st.getConsent.get(handle), 'consent'),
    setConsent: (handle, c) => st.setConsent.run(handle, JSON.stringify(c)),
    counters: (handle) => Object.fromEntries(st.counters.all(handle).map((r) => [r.purpose, r.n])),
    /** Add to a counter, at most `cap` per UTC day. Returns how much was counted. */
    bump(handle, purpose, n, cap, now = Date.now()) {
      return tx(() => {
        const day = utcDay(now);
        const used = st.daily.get(handle, purpose, day)?.n || 0;
        const add = Math.max(0, Math.min(n, cap - used));
        if (!add) return 0;
        st.bump.run(handle, purpose, add);
        st.bumpDaily.run(handle, purpose, day, add);
        return add;
      });
    },
    pruneDaily: (now = Date.now()) => st.pruneDaily.run(utcDay(now - 2 * 86400_000)).changes,
    balance: (handle) => st.balance.get(handle)?.fab || 0,

    // ----- hash-chained ledger -----
    appendLedger(entry) {
      return tx(() => {
        const head = st.ledgerHead.get();
        const seq = head ? head.seq + 1 : 0;
        const body = { seq, at: new Date().toISOString(), prev: head?.hash || GENESIS, ...entry };
        const text = JSON.stringify(body);
        const hash = createHash('sha256').update(text).digest('hex');
        st.ledgerAdd.run(seq, entry.kind, entry.kind === 'consent' ? entry.handle : null, text, hash);
        return { ...body, hash };
      });
    },
    /** Settlement: ledger entry, payouts and balances in one transaction. */
    recordSettlement(entry) {
      return tx(() => {
        const e = store.appendLedger(entry);
        for (const [h, cents] of Object.entries(entry.allocations)) {
          st.payoutAdd.run(h, e.seq, cents, entry.fab[h]);
          st.credit.run(h, entry.fab[h]);
        }
        return e;
      });
    },
    verifyLedger() {
      let prev = GENESIS;
      let seq = 0;
      for (const row of st.ledgerAll.all()) {
        const body = JSON.parse(row.body);
        if (row.seq !== seq++ || body.seq !== row.seq || body.prev !== prev) return false;
        if (createHash('sha256').update(row.body).digest('hex') !== row.hash) return false;
        prev = row.hash;
      }
      return true;
    },
    ledgerHead: () => st.ledgerHead.get() || { seq: -1, hash: GENESIS },
    ledgerRecent: (limit) => st.ledgerRecent.all(limit).map(entryOf).reverse(),
    receipts: (handle, limit = 10) => st.receipts.all(handle, limit).map(entryOf).reverse(),
    payouts: (handle, limit = 10) => st.payouts.all(handle, limit).reverse()
      .map((r) => ({ seq: r.seq, at: JSON.parse(r.body).at, cents: r.cents, fab: r.fab, hash: r.hash })),

    // ----- inspection (tests, operators) -----
    // ----- linked phone numbers: HMAC(pepper, number) -> account, never the number itself -----
    numberLinkOf: (handle) => linkRow(db.prepare('SELECT * FROM phone_links WHERE handle = ?').get(String(handle))),
    numberLinkByMac: (mac) => linkRow(db.prepare('SELECT * FROM phone_links WHERE number_mac = ?').get(String(mac))),
    /** Links a number to an account; returns who had it before (a recycled number), if anyone. */
    linkNumber(mac, handle, at, discoverable = false) {
      let prev = null;
      store.tx(() => {
        prev = db.prepare('SELECT handle FROM phone_links WHERE number_mac = ?').get(String(mac))?.handle || null;
        db.prepare('DELETE FROM phone_links WHERE number_mac = ? OR handle = ?').run(String(mac), String(handle));
        db.prepare('INSERT INTO phone_links (number_mac, handle, verified_at, discoverable) VALUES (?, ?, ?, ?)').run(String(mac), String(handle), at, discoverable ? 1 : 0);
      });
      return prev;
    },
    unlinkNumber: (handle) => db.prepare('DELETE FROM phone_links WHERE handle = ?').run(String(handle)),
    setNumberDiscoverable: (handle, on) => db.prepare('UPDATE phone_links SET discoverable = ? WHERE handle = ?').run(on ? 1 : 0, String(handle)),
    // ----- phone (PSTN through a carrier; not end-to-end encrypted) -----
    numberOf: (handle) => db.prepare('SELECT number FROM phone_numbers WHERE handle = ?').get(String(handle))?.number || null,
    handleOfNumber: (number) => db.prepare('SELECT handle FROM phone_numbers WHERE number = ?').get(String(number))?.handle || null,
    assignNumber(number, handle) {
      store.tx(() => {
        db.prepare('DELETE FROM phone_numbers WHERE number = ? OR handle = ?').run(String(number), String(handle ?? ''));
        if (handle) db.prepare('INSERT INTO phone_numbers (number, handle) VALUES (?, ?)').run(String(number), String(handle));
      });
    },
    numbers: () => db.prepare('SELECT number, handle FROM phone_numbers ORDER BY number').all(),
    // ----- burner numbers: a pool of the operator's numbers, lent to accounts with a bundle -----
    /** Who a number rings: an account's main number, or one of its burner lines. */
    ownerOfNumber(number) {
      const n = String(number);
      const main = db.prepare('SELECT handle FROM phone_numbers WHERE number = ?').get(n);
      if (main) return { handle: main.handle, burner: false };
      const line = db.prepare('SELECT handle FROM burner_lines WHERE number = ?').get(n);
      return line ? { handle: line.handle, burner: true } : null;
    },
    addToPool(number, freeAt = 0) {
      const n = String(number);
      if (db.prepare('SELECT 1 FROM phone_numbers WHERE number = ? UNION SELECT 1 FROM burner_lines WHERE number = ?').get(n, n)) return false;
      db.prepare('INSERT INTO burner_pool (number, free_at) VALUES (?, ?) ON CONFLICT (number) DO NOTHING').run(n, freeAt);
      return true;
    },
    removeFromPool: (number) => Number(db.prepare('DELETE FROM burner_pool WHERE number = ?').run(String(number)).changes),
    poolStats(now = Date.now()) {
      const r = db.prepare('SELECT COUNT(*) AS total, SUM(free_at <= ?) AS free FROM burner_pool').get(now);
      return { total: Number(r.total), free: Number(r.free || 0), lent: Number(db.prepare('SELECT COUNT(*) AS n FROM burner_lines').get().n) };
    },
    poolHasFree: (now = Date.now()) => Boolean(db.prepare('SELECT 1 FROM burner_pool WHERE free_at <= ? LIMIT 1').get(now)),
    burnerLines: (handle) => db.prepare('SELECT number, created_at AS createdAt, rotated_from AS rotatedFrom FROM burner_lines WHERE handle = ? ORDER BY created_at, number').all(String(handle))
      .map((r) => ({ number: r.number, createdAt: r.createdAt, rotatedFrom: r.rotatedFrom || null })),
    ownsLine: (handle, number) => Boolean(db.prepare('SELECT 1 FROM burner_lines WHERE handle = ? AND number = ?').get(String(handle), String(number))),
    burnerSlots: (handle, now = Date.now()) => Number(db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM burner_bundles WHERE handle = ? AND expires_at > ?').get(String(handle), now).n),
    burnerBundles: (handle, now = Date.now()) => db.prepare('SELECT id, size, period, expires_at AS expiresAt FROM burner_bundles WHERE handle = ? AND expires_at > ? ORDER BY expires_at').all(String(handle), now),
    grantBundle({ id, handle, size, period, expiresAt }) {
      db.prepare('INSERT INTO burner_bundles (id, handle, size, period, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET size = excluded.size, period = excluded.period, expires_at = excluded.expires_at')
        .run(String(id), String(handle), size, period, expiresAt);
    },
    /** Lends a free pool number to an account; null when the pool has none ready. */
    takeLine(handle, now = Date.now(), rotatedFrom = null) {
      let number = null;
      store.tx(() => {
        const r = db.prepare('SELECT number FROM burner_pool WHERE free_at <= ? ORDER BY free_at, number LIMIT 1').get(now);
        if (!r) return;
        db.prepare('DELETE FROM burner_pool WHERE number = ?').run(r.number);
        db.prepare('INSERT INTO burner_lines (number, handle, created_at, rotated_from) VALUES (?, ?, ?, ?)').run(r.number, String(handle), now, rotatedFrom);
        number = r.number;
      });
      return number;
    },
    /**
     * Burns a line: it stops ringing this account at once, the relay forgets its calls and texts,
     * and the number rests in the pool until `freeAt` so its callers don't reach the next person.
     */
    burnLine(handle, number, freeAt) {
      let ok = false;
      store.tx(() => {
        if (!db.prepare('DELETE FROM burner_lines WHERE handle = ? AND number = ?').run(String(handle), String(number)).changes) return;
        db.prepare("DELETE FROM phone_log WHERE handle = ? AND json_extract(event, '$.via') = ?").run(String(handle), String(number));
        db.prepare('INSERT INTO burner_pool (number, free_at) VALUES (?, ?) ON CONFLICT (number) DO UPDATE SET free_at = excluded.free_at').run(String(number), freeAt);
        ok = true;
      });
      return ok;
    },
    /** Accounts with more lines than their unexpired bundles allow (newest lines first). */
    excessLines(now = Date.now()) {
      const out = [];
      for (const { handle } of db.prepare('SELECT DISTINCT handle FROM burner_lines').all()) {
        const lines = db.prepare('SELECT number FROM burner_lines WHERE handle = ? ORDER BY created_at DESC, number DESC').all(handle);
        const over = lines.length - store.burnerSlots(handle, now);
        for (const l of lines.slice(0, Math.max(0, over))) out.push({ handle, number: l.number });
      }
      return out;
    },
    addPhoneEvent(handle, event) {
      const at = event.at || Date.now();
      const r = db.prepare('INSERT INTO phone_log (handle, at, event, call_sid) VALUES (?, ?, ?, ?)')
        .run(String(handle), at, JSON.stringify(event), event.callSid ? String(event.callSid) : null);
      return { seq: Number(r.lastInsertRowid), ...event, at };
    },
    phoneLog: (handle, limit = 100) => db.prepare('SELECT seq, at, event FROM phone_log WHERE handle = ? ORDER BY seq DESC LIMIT ?')
      .all(String(handle), limit).map((r) => ({ ...JSON.parse(r.event), seq: r.seq, at: r.at })).reverse(),
    phoneEvent: (handle, seq) => {
      const r = db.prepare('SELECT seq, at, event FROM phone_log WHERE handle = ? AND seq = ?').get(String(handle), Number(seq));
      return r ? { ...JSON.parse(r.event), seq: r.seq, at: r.at } : null;
    },
    callOwner: (callSid) => db.prepare('SELECT handle, event FROM phone_log WHERE call_sid = ? ORDER BY seq LIMIT 1').get(String(callSid)) || null,
    expirePhoneLog: (before) => Number(db.prepare('DELETE FROM phone_log WHERE at < ?').run(before).changes),

    counts: () => Object.fromEntries(['accounts', 'spks', 'opks', 'queue', 'ledger'].map((t) => [t, st.count(t).get().n])),
    dump() {
      const out = {};
      for (const t of ['accounts', 'spks', 'opks', 'queue', 'consent', 'counters', 'balances', 'ledger', 'payouts']) {
        out[t] = db.prepare(`SELECT * FROM ${t}`).all();
      }
      return out;
    },
  };

  if (importJson && fs.existsSync(importJson) && !store.handles().length) importLegacy(store, importJson);
  return store;
}

/** One-time import of the v0.4/v0.5 JSON state file. The file is renamed, not deleted. */
function importLegacy(store, file) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.tx(() => {
    for (const [h, d] of Object.entries(s.directory || {})) store.putList(h, d.list);
    for (const [addr, pk] of Object.entries(s.prekeys || {})) {
      if (pk.spk) store.setSpk(addr, pk.spk);
      store.addOpks(addr, pk.opks || [], 200);
    }
    for (const [addr, envs] of Object.entries(s.queues || {})) for (const e of envs) store.enqueue(addr, e, 1e9);
    for (const [h, c] of Object.entries(s.consent || {})) store.setConsent(h, c);
    for (const [h, cs] of Object.entries(s.counters || {})) {
      for (const [p, n] of Object.entries(cs)) store.db.prepare('INSERT INTO counters (handle, purpose, n) VALUES (?, ?, ?)').run(h, p, n);
    }
    for (const [h, fab] of Object.entries(s.balances || {})) store.db.prepare('INSERT INTO balances (handle, fab) VALUES (?, ?)').run(h, fab);
    // the old ledger is re-chained as-is: same bodies, same hashes
    for (const e of s.ledger || []) {
      const { hash, ...body } = e;
      store.db.prepare('INSERT INTO ledger (seq, kind, handle, body, hash) VALUES (?, ?, ?, ?, ?)')
        .run(body.seq, body.kind, body.kind === 'consent' ? body.handle : null, JSON.stringify(body), hash);
      if (body.kind === 'settlement') {
        for (const [h, cents] of Object.entries(body.allocations || {})) {
          store.db.prepare('INSERT INTO payouts (handle, seq, cents, fab) VALUES (?, ?, ?, ?)').run(h, body.seq, cents, body.fab[h]);
        }
      }
    }
  });
  fs.renameSync(file, file + '.imported');
}
