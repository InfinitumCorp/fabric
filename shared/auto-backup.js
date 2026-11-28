// When the web client saves its backup to Cumulus again by itself ("Keep it up to date").
// The device remembers the recovery key of the last Cumulus save (inside its encrypted vault)
// and re-seals a fresh backup under that same key, so the key written down keeps working.
// Pure, so the rules are tested without a browser.

export const AUTO_BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const AUTO_BACKUP_RETRY_MS = 60 * 60 * 1000; // after a failed attempt

/**
 * 'due' | a reason it is not: 'off', 'not-primary', 'not-linked', 'passphrase', 'offline', 'recent'.
 * A vault with a passphrase asks for it before the account key leaves, so it is never done silently.
 */
export function autoBackupState({ auto, primary, linked, passphrase, online, now = Date.now() }) {
  if (!auto?.key) return 'off';
  if (!primary) return 'not-primary';
  if (!linked) return 'not-linked';
  if (passphrase) return 'passphrase';
  if (!online) return 'offline';
  const wait = auto.error ? AUTO_BACKUP_RETRY_MS : AUTO_BACKUP_EVERY_MS;
  return now - (auto.tried || auto.at || 0) >= wait ? 'due' : 'recent';
}
