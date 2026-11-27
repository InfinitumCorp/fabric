// Storage per account for posts in large groups and channels (shared/tiers.js storageBytes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../server/store.js';
import { createSpaces } from '../server/spaces.js';
import { TIERS, compareRows } from '../shared/tiers.js';

const body = (e, n) => ({ e, iv: 'A'.repeat(16), ct: 'B'.repeat(n) });
let ids = 0;
const pid = () => `post-${String(++ids).padStart(8, '0')}`;

test('plans: storage for posts', () => {
  assert.equal(TIERS.free.storageBytes, 1024 ** 3);
  assert.equal(TIERS.plus.storageBytes, 20 * 1024 ** 3);
  assert.deepEqual(compareRows().find((r) => r[0] === 'Storage for your posts there'), ['Storage for your posts there', '1 GB', '20 GB']);
});

test('spaces: an account\'s posts are capped in total; deleting frees room; others are not affected', () => {
  const store = openStore(null);
  const one = Buffer.byteLength(JSON.stringify(body(0, 1000)));
  const spaces = createSpaces({ store, secret: 's', entitlements: () => ({ ...TIERS.free, storageBytes: one * 2 }) }).ops;
  const { space } = spaces.create('@ana.veil', { kind: 'group', visibility: 'private', name: 'G' });
  const a1 = spaces.post('@ana.veil', { sid: space.id, id: pid(), body: body(space.epoch ?? 0, 1000) });
  spaces.post('@ana.veil', { sid: space.id, id: pid(), body: body(space.epoch ?? 0, 1000) });
  assert.throws(() => spaces.post('@ana.veil', { sid: space.id, id: pid(), body: body(space.epoch ?? 0, 1000) }), (e) => e.status === 413 && /storage full/.test(e.message));
  spaces.delete_post('@ana.veil', { sid: space.id, seq: a1.post.seq });
  spaces.post('@ana.veil', { sid: space.id, id: pid(), body: body(space.epoch ?? 0, 1000) }); // room again
  store.close();
});

test('spaces: posts from before the cap are counted after an upgrade', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-quota-'));
  const file = path.join(dir, 'fabric.db');
  // a database whose space_posts table has no size column yet
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE space_posts (seq INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, id TEXT NOT NULL UNIQUE, author TEXT NOT NULL,
    body TEXT NOT NULL, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0);`);
  db.prepare('INSERT INTO space_posts (sid, id, author, body, at) VALUES (?, ?, ?, ?, ?)').run('x', 'old-1', '@ana.veil', 'x'.repeat(5000), 1);
  db.prepare("INSERT INTO space_posts (sid, id, author, body, at, deleted) VALUES (?, ?, ?, '{}', ?, 1)").run('x', 'old-2', '@ana.veil', 1);
  db.close();
  const store = openStore(file);
  const spaces = createSpaces({ store, secret: 's', entitlements: () => ({ ...TIERS.free, storageBytes: 6000 }) }).ops;
  assert.equal(store.db.prepare('SELECT SUM(bytes) AS n FROM space_posts').get().n, 5000);
  const { space } = spaces.create('@ana.veil', { kind: 'group', visibility: 'private', name: 'G' });
  assert.throws(() => spaces.post('@ana.veil', { sid: space.id, id: pid(), body: body(space.epoch ?? 0, 1500) }), /storage full/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
