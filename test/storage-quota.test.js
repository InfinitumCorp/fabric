// Per-account storage: the envelopes waiting for all devices of one account share one cap, and
// the account's own devices can see what the relay keeps for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.js';
import { createRelay } from '../server/relay.js';
import { signIn } from './phone-helpers.js';

const env = (id, n) => ({ id, ts: 1, ct: 'x'.repeat(n) });
const size = (e) => Buffer.byteLength(JSON.stringify(e));

test('store: one cap for every device of an account', () => {
  const s = openStore(null);
  const one = size(env('a1', 1000));
  const caps = { maxBytes: one * 10, accountMaxBytes: one * 3 };
  assert.equal(s.enqueue('@b.veil#1', env('a1', 1000), 100, caps), 'queued');
  assert.equal(s.enqueue('@b.veil#2', env('a2', 1000), 100, caps), 'queued');
  assert.equal(s.enqueue('@b.veil#3', env('a3', 1000), 100, caps), 'queued');
  assert.equal(s.enqueue('@b.veil#4', env('a4', 1000), 100, caps), 'account full', 'a new device does not add room');
  assert.equal(s.accountQueueBytes('@b.veil'), one * 3);
  // other accounts, including ones whose handle starts the same, are counted apart
  assert.equal(s.enqueue('@b.veil2#1', env('c1', 1000), 100, caps), 'queued');
  assert.equal(s.enqueue('@b.vei#1', env('c2', 1000), 100, caps), 'queued');
  assert.equal(s.accountQueueBytes('@b.veil'), one * 3);
  // acknowledging frees room for the whole account
  s.ack('@b.veil#2', 'a2');
  assert.equal(s.enqueue('@b.veil#4', env('a4', 1000), 100, caps), 'queued');
  assert.deepEqual(s.storageUsage('@b.veil'), { waiting: one * 3, backup: 0, voicemail: 0 });
  s.putBackup('@b.veil', 'y'.repeat(500));
  assert.equal(s.storageUsage('@b.veil').backup, 500);
});

test('relay: senders see a full queue once the account cap is hit; storage shows usage', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, accountQueueBytes: 3000 });
  t.after(() => relay.close());
  const ana = await signIn(relay.port, '@ana.veil');
  const ben = await signIn(relay.port, '@ben.veil');
  t.after(() => { ana.ws.close(); ben.ws.close(); });
  ben.ws.close(); // offline, so envelopes wait on the relay
  await new Promise((r) => setTimeout(r, 100));

  // the send op answers with `ack`, or an `error` whose ref is the envelope id
  const sendOne = async (i) => {
    const id = `m${i}`;
    ana.send({ type: 'send', envelope: { id, from: '@ana.veil', fromDevice: ana.deviceId, to: '@ben.veil', toDevice: ben.deviceId, ts: Date.now(), header: {}, ct: 'z'.repeat(900) } });
    return ana.next((m) => (m.type === 'ack' && m.id === id) || (m.type === 'error' && m.ref === id));
  };
  const replies = [];
  for (let i = 0; i < 6; i++) replies.push(await sendOne(i));
  const firstFull = replies.findIndex((m) => m.type === 'error');
  assert.ok(firstFull >= 2, 'a couple of envelopes fit');
  assert.equal(replies[firstFull].error, 'recipient queue full');
  assert.ok(replies.slice(firstFull).every((m) => m.error === 'recipient queue full'));
  const mine = await ana.ask({ type: 'storage' }, 'storage');
  assert.equal(mine.waiting.used, 0);
  assert.equal(mine.waiting.max, 3000);
  assert.ok(mine.posts.max > 0 && mine.backup.max > 0);
  assert.equal(mine.voicemail.used, 0);
});
