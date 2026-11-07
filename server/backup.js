// Supabase as the relay's system of record. The relay keeps working from its local SQLite file;
// this module copies a consistent snapshot of it to Supabase (through the fabric-store edge
// function) whenever it has changed, and restores it on a fresh host before the relay opens it.
//
// Snapshots are sealed with AES-256-GCM under FABRIC_BACKUP_KEY before they leave this machine,
// so Supabase holds only ciphertext. Without that key a snapshot cannot be read or restored.
//
//   FABRIC_SUPABASE_STORE  https://<project>.supabase.co/functions/v1/fabric-store
//   FABRIC_SUPABASE_KEY    gateway key; its SHA-256 is listed in fabric.gateway_keys
//   FABRIC_BACKUP_KEY      32 bytes, base64url
//   FABRIC_BACKUP_NAME     snapshot name (default "relay")
//   FABRIC_BACKUP_MINUTES  how often to check for changes (default 2)

import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('FBK1');
const NAME = /^[a-z0-9-]{1,40}$/;

export function backupFromEnv(env = process.env) {
  if (!env.FABRIC_SUPABASE_STORE) return null;
  const url = new URL(env.FABRIC_SUPABASE_STORE);
  if (url.protocol !== 'https:') throw new Error('FABRIC_SUPABASE_STORE must be https');
  if (!env.FABRIC_SUPABASE_KEY || env.FABRIC_SUPABASE_KEY.length < 32) throw new Error('FABRIC_SUPABASE_KEY missing or too short');
  const key = Buffer.from(env.FABRIC_BACKUP_KEY || '', 'base64url');
  if (key.length !== 32) throw new Error('FABRIC_BACKUP_KEY must be 32 bytes, base64url');
  const name = env.FABRIC_BACKUP_NAME || 'relay';
  if (!NAME.test(name)) throw new Error('FABRIC_BACKUP_NAME must match [a-z0-9-]{1,40}');
  const minutes = Number(env.FABRIC_BACKUP_MINUTES || 2);
  return { url: url.toString(), gatewayKey: env.FABRIC_SUPABASE_KEY, key, name, intervalMs: Math.max(0.1, minutes) * 60_000 };
}

export function seal(key, plain, name) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(name));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function open(key, sealed, name) {
  if (sealed.length < 32 || !sealed.subarray(0, 4).equals(MAGIC)) throw new Error('not a FABRIC snapshot');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(4, 16));
  d.setAAD(Buffer.from(name));
  d.setAuthTag(sealed.subarray(16, 32));
  return Buffer.concat([d.update(sealed.subarray(32)), d.final()]);
}

export function createBackup({ url, gatewayKey, key, name, intervalMs = 120_000, fetchImpl = globalThis.fetch, log = console.log }) {
  const endpoint = `${url}${url.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}`;
  const headers = { 'x-fabric-key': gatewayKey };
  let timer = null;
  let lastChanges = -1;
  let running = null;

  /** Writes the stored snapshot to `file` if `file` does not exist yet. Returns true if restored. */
  async function restoreIfMissing(file) {
    if (fs.existsSync(file)) return false;
    const res = await fetchImpl(endpoint, { headers });
    if (res.status === 404) { log('[backup] no snapshot in Supabase yet; starting empty'); return false; }
    if (!res.ok) throw new Error(`[backup] restore failed: ${res.status}`);
    const plain = open(key, Buffer.from(await res.arrayBuffer()), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.restore-${process.pid}`;
    fs.writeFileSync(tmp, plain);
    fs.renameSync(tmp, file);
    log(`[backup] restored ${plain.length} bytes from Supabase`);
    return true;
  }

  /** Uploads a snapshot of `store` if anything changed since the last upload (or `force`). */
  async function push(store, { force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const changes = Number(store.db.prepare('SELECT total_changes() AS n').get().n);
      if (!force && changes === lastChanges) return false;
      const dir = fs.mkdtempSync(path.join(path.dirname(store.file || '.') || '.', '.snap-'));
      const tmp = path.join(dir, 'snap.db');
      try {
        store.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        const body = seal(key, fs.readFileSync(tmp), name);
        const res = await fetchImpl(endpoint, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body });
        if (!res.ok) throw new Error(`upload ${res.status}`);
        lastChanges = changes;
        return true;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })().catch((err) => { log(`[backup] ${err.message}`); return false; }).finally(() => { running = null; });
    return running;
  }

  return {
    restoreIfMissing,
    push,
    start(store) {
      timer = setInterval(() => push(store), intervalMs);
      timer.unref?.();
      return push(store, { force: true });
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
