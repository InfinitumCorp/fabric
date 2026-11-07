import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../server/store.js';
import { backupFromEnv, createBackup, seal, open } from '../server/backup.js';

// stands in for the fabric-store edge function
function fakeStore(gatewayKey) {
  const objects = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(init.method || 'GET');
    if (init.headers?.['x-fabric-key'] !== gatewayKey) return new Response('{}', { status: 401 });
    const name = u.searchParams.get('name');
    if ((init.method || 'GET') === 'GET') return objects.has(name) ? new Response(objects.get(name)) : new Response('{}', { status: 404 });
    objects.set(name, Buffer.from(init.body));
    return new Response('{"ok":true}');
  };
  return { objects, calls, fetchImpl };
}

test('backup: seal/open round trip, wrong name or key fails', () => {
  const key = randomBytes(32);
  const s = seal(key, Buffer.from('hello'), 'relay');
  assert.equal(open(key, s, 'relay').toString(), 'hello');
  assert.throws(() => open(key, s, 'other'));
  assert.throws(() => open(randomBytes(32), s, 'relay'));
  assert.ok(!s.includes(Buffer.from('hello')));
});

test('backup: env validation', () => {
  assert.equal(backupFromEnv({}), null);
  assert.throws(() => backupFromEnv({ FABRIC_SUPABASE_STORE: 'http://x.supabase.co/functions/v1/fabric-store' }), /https/);
  const ok = backupFromEnv({ FABRIC_SUPABASE_STORE: 'https://x.supabase.co/functions/v1/fabric-store', FABRIC_SUPABASE_KEY: 'k'.repeat(40), FABRIC_BACKUP_KEY: randomBytes(32).toString('base64url') });
  assert.equal(ok.name, 'relay');
  assert.throws(() => backupFromEnv({ FABRIC_SUPABASE_STORE: 'https://x/', FABRIC_SUPABASE_KEY: 'k'.repeat(40), FABRIC_BACKUP_KEY: 'short' }), /32 bytes/);
});

test('backup: push only when changed, restore on a fresh host', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-backup-'));
  const gatewayKey = 'g'.repeat(40);
  const key = randomBytes(32);
  const remote = fakeStore(gatewayKey);
  const cfg = { url: 'https://x.supabase.co/functions/v1/fabric-store', gatewayKey, key, name: 'relay', fetchImpl: remote.fetchImpl, log: () => {} };

  const a = createBackup(cfg);
  const fileA = path.join(dir, 'a.db');
  assert.equal(await a.restoreIfMissing(fileA), false); // nothing stored yet
  const storeA = openStore(fileA);
  storeA.db.exec('CREATE TABLE IF NOT EXISTS probe (v TEXT)');
  storeA.db.prepare('INSERT INTO probe (v) VALUES (?)').run('kept');
  assert.equal(await a.push(storeA), true);
  assert.equal(await a.push(storeA), false); // unchanged: no upload
  storeA.db.prepare('INSERT INTO probe (v) VALUES (?)').run('kept too');
  assert.equal(await a.push(storeA), true);
  storeA.close();
  assert.ok(!remote.objects.get('relay').includes(Buffer.from('kept too'))); // only ciphertext leaves

  const fileB = path.join(dir, 'b.db');
  const b = createBackup(cfg);
  assert.equal(await b.restoreIfMissing(fileB), true);
  assert.equal(await b.restoreIfMissing(fileB), false); // never overwrites a local file
  const storeB = openStore(fileB);
  assert.deepEqual(storeB.db.prepare('SELECT v FROM probe').all().map((r) => r.v), ['kept', 'kept too']);
  storeB.close();

  const bad = createBackup({ ...cfg, gatewayKey: 'x'.repeat(40) });
  await assert.rejects(bad.restoreIfMissing(path.join(dir, 'c.db')), /401/);
  fs.rmSync(dir, { recursive: true, force: true });
});
