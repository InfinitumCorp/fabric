import test from 'node:test';
import assert from 'node:assert/strict';
import { autoBackupState, AUTO_BACKUP_EVERY_MS, AUTO_BACKUP_RETRY_MS } from '../shared/auto-backup.js';

test('auto backup to Cumulus: when it runs', () => {
  const now = 10 * AUTO_BACKUP_EVERY_MS;
  const ok = { auto: { key: 'K', at: now - AUTO_BACKUP_EVERY_MS }, primary: true, linked: true, passphrase: false, online: true, now };
  assert.equal(autoBackupState(ok), 'due');
  assert.equal(autoBackupState({ ...ok, auto: null }), 'off');
  assert.equal(autoBackupState({ ...ok, auto: { at: 0 } }), 'off', 'no remembered key, nothing to seal with');
  assert.equal(autoBackupState({ ...ok, primary: false }), 'not-primary');
  assert.equal(autoBackupState({ ...ok, linked: false }), 'not-linked');
  assert.equal(autoBackupState({ ...ok, passphrase: true }), 'passphrase', 'never exports the account key without the passphrase');
  assert.equal(autoBackupState({ ...ok, online: false }), 'offline');
  assert.equal(autoBackupState({ ...ok, auto: { key: 'K', at: now - 1000 } }), 'recent');
  // after a failure: tried again an hour later, not a day
  const failed = { key: 'K', at: now - 2 * AUTO_BACKUP_EVERY_MS, tried: now - AUTO_BACKUP_RETRY_MS + 1, error: 'Upload failed.' };
  assert.equal(autoBackupState({ ...ok, auto: failed }), 'recent');
  assert.equal(autoBackupState({ ...ok, auto: { ...failed, tried: now - AUTO_BACKUP_RETRY_MS } }), 'due');
});
