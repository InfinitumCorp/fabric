// FABRIC local vault: everything the device keeps, encrypted at rest.
//
//   storage key   AES-256-GCM, never extractable in memory. Either
//                 - "device" mode: a non-extractable CryptoKey stored as-is in IndexedDB, or
//                 - "passphrase" mode: wrapped under PBKDF2-SHA256(passphrase, 600k iterations),
//                   so a copy of the browser profile is useless without the passphrase.
//   identity      long-term DH + signing private keys, encrypted under the storage key and
//                 unwrapped straight into non-extractable CryptoKeys. Page script can use
//                 them but can never read them out.
//   state         contacts, history, ratchet sessions and prekeys as one AES-GCM blob.
//
// Every ciphertext carries a purpose label as AAD, so blobs cannot be swapped for one another.
// The backend is a tiny key-value interface (IndexedDB in the browser, memory in tests):
//   get(key) -> value | null      putMany({key: value | null}) -> atomic write (null deletes)

import { b64, unb64, ECDH, ECDSA, publicOnly } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
export const MIN_PASSPHRASE = 8;

const AES = { name: 'AES-GCM', length: 256 };
const SK_USAGES = ['encrypt', 'decrypt', 'unwrapKey'];
const LABEL = {
  sk: 'FABRIC/vault/v1/storage-key',
  state: 'FABRIC/vault/v1/state',
  dh: 'FABRIC/vault/v1/identity/dh',
  sig: 'FABRIC/vault/v1/identity/sig',
  account: 'FABRIC/vault/v1/identity/account',
};
const PARTS = {
  dh: { alg: ECDH, usages: ['deriveBits'] },
  sig: { alg: ECDSA, usages: ['sign'] },
  account: { alg: ECDSA, usages: ['sign'] }, // primary device only
};

const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const gcm = (label, iv) => ({ name: 'AES-GCM', iv, additionalData: enc.encode(label) });

async function seal(key, label, bytes) {
  const iv = rand(12);
  return { iv: b64(iv), ct: b64(await subtle.encrypt(gcm(label, iv), key, bytes)) };
}

async function unseal(key, label, box) {
  return new Uint8Array(await subtle.decrypt(gcm(label, unb64(box.iv)), key, unb64(box.ct)));
}

async function passphraseKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, AES, false, ['wrapKey', 'unwrapKey']);
}

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function memoryBackend() {
  const m = new Map();
  return {
    map: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async putMany(obj) {
      for (const [k, v] of Object.entries(obj)) {
        if (v == null) m.delete(k); else m.set(k, v);
      }
    },
  };
}

export class Vault {
  constructor(backend, { iterations = PBKDF2_ITERATIONS } = {}) {
    this.backend = backend;
    this.iterations = iterations;
    this.sk = null;
    this.queue = Promise.resolve();
    this.saveSeq = 0;
  }

  meta() { return this.backend.get('meta'); }
  async exists() { return Boolean(await this.meta()); }
  get unlocked() { return Boolean(this.sk); }

  /** Serialize every operation that reads or replaces the storage key. */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---------- internals ----------
  async newStorageKey(passphrase) {
    if (!passphrase) {
      const sk = await subtle.generateKey(AES, false, SK_USAGES);
      return { sk, records: { meta: { v: 1, mode: 'device', createdAt: Date.now() }, deviceKey: sk } };
    }
    if (passphrase.length < MIN_PASSPHRASE) throw new VaultError('weak', `Use at least ${MIN_PASSPHRASE} characters.`);
    const salt = rand(16);
    const kek = await passphraseKey(passphrase, salt, this.iterations);
    const tmp = await subtle.generateKey(AES, true, SK_USAGES); // extractable only long enough to wrap
    const iv = rand(12);
    const wrapped = await subtle.wrapKey('raw', tmp, kek, gcm(LABEL.sk, iv));
    const sk = await subtle.unwrapKey('raw', wrapped, kek, gcm(LABEL.sk, iv), AES, false, SK_USAGES);
    return {
      sk,
      records: {
        meta: {
          v: 1, mode: 'passphrase', createdAt: Date.now(),
          kdf: { name: 'PBKDF2-SHA256', salt: b64(salt), iterations: this.iterations },
          wrappedKey: { iv: b64(iv), ct: b64(wrapped) },
        },
        deviceKey: null,
      },
    };
  }

  async unwrapStorageKey(meta, passphrase) {
    if (meta.mode === 'device') {
      const sk = await this.backend.get('deviceKey');
      if (!sk) throw new VaultError('corrupt', 'Device key is missing.');
      return sk;
    }
    if (!passphrase) throw new VaultError('locked', 'Passphrase required.');
    const kek = await passphraseKey(passphrase, unb64(meta.kdf.salt), meta.kdf.iterations);
    try {
      return await subtle.unwrapKey('raw', unb64(meta.wrappedKey.ct), kek, gcm(LABEL.sk, unb64(meta.wrappedKey.iv)), AES, false, SK_USAGES);
    } catch {
      throw new VaultError('bad-passphrase', 'Wrong passphrase.');
    }
  }

  async wrapIdentity(sk, jwkIdentity) {
    const out = {};
    for (const part of Object.keys(PARTS)) {
      if (!jwkIdentity[part]) continue;
      out[part] = {
        publicJwk: publicOnly(jwkIdentity[part].publicJwk),
        wrapped: await seal(sk, LABEL[part], enc.encode(JSON.stringify(jwkIdentity[part].privateJwk))),
      };
    }
    return out;
  }

  async unwrapIdentity(sk, record) {
    const out = {};
    for (const [part, { alg, usages }] of Object.entries(PARTS)) {
      if (!record[part]) continue;
      const w = record[part].wrapped;
      const privateKey = await subtle.unwrapKey(
        'jwk', unb64(w.ct), sk, gcm(LABEL[part], unb64(w.iv)), alg, false, usages,
      );
      out[part] = { publicJwk: record[part].publicJwk, privateKey };
    }
    return out;
  }

  /** Decrypts the identity's private JWKs. Only used to re-encrypt them under a new storage key. */
  async readIdentityJwks(sk, record) {
    const out = {};
    for (const part of Object.keys(PARTS)) {
      if (!record[part]) continue;
      const jwk = JSON.parse(dec.decode(await unseal(sk, LABEL[part], record[part].wrapped)));
      out[part] = { publicJwk: record[part].publicJwk, privateJwk: jwk };
    }
    return out;
  }

  // ---------- API ----------
  /**
   * Create the vault from a freshly generated identity (JWK form). The caller should drop its
   * JWK copy afterwards and use only the returned non-extractable identity.
   */
  create({ identity, state, passphrase = null }) {
    return this.serial(async () => {
      if (await this.exists()) throw new VaultError('exists', 'A vault already exists on this device.');
      const { sk, records } = await this.newStorageKey(passphrase);
      records.identity = await this.wrapIdentity(sk, identity);
      records.state = await seal(sk, LABEL.state, enc.encode(JSON.stringify(state)));
      await this.backend.putMany(records);
      this.sk = sk;
      return this.unwrapIdentity(sk, records.identity);
    });
  }

  /** Returns { identity (non-extractable CryptoKeys), state }. */
  unlock(passphrase = null) {
    return this.serial(async () => {
      const meta = await this.meta();
      if (!meta) throw new VaultError('missing', 'No vault on this device.');
      const sk = await this.unwrapStorageKey(meta, passphrase);
      const identity = await this.unwrapIdentity(sk, await this.backend.get('identity'));
      const state = JSON.parse(dec.decode(await unseal(sk, LABEL.state, await this.backend.get('state'))));
      this.sk = sk;
      return { identity, state };
    });
  }

  /**
   * Encrypt and store the state. The snapshot is taken now; if newer saves are queued behind
   * this one, only the newest is written. Resolves once the newest snapshot is on disk.
   */
  save(state) {
    const snapshot = JSON.stringify(state);
    const seq = ++this.saveSeq;
    const run = this.serial(async () => {
      if (seq !== this.saveSeq) return; // superseded; the newer save writes a newer snapshot
      if (!this.sk) throw new VaultError('locked', 'Vault is locked.');
      await this.backend.putMany({ state: await seal(this.sk, LABEL.state, enc.encode(snapshot)) });
    });
    this.newestSave = run;
    // a superseded save resolves only when the snapshot that replaced it is on disk
    return run.then(() => this.newestSave);
  }

  /** Set, change (newPassphrase) or remove (null) the passphrase. Requires the current one if set. */
  setPassphrase(newPassphrase, currentPassphrase = null) {
    return this.serial(async () => {
      if (!this.sk) throw new VaultError('locked', 'Vault is locked.');
      const meta = await this.meta();
      if (meta.mode === 'passphrase') await this.unwrapStorageKey(meta, currentPassphrase); // proves knowledge
      const jwks = await this.readIdentityJwks(this.sk, await this.backend.get('identity'));
      const state = await unseal(this.sk, LABEL.state, await this.backend.get('state'));
      const { sk, records } = await this.newStorageKey(newPassphrase);
      records.identity = await this.wrapIdentity(sk, jwks);
      records.state = await seal(sk, LABEL.state, state);
      await this.backend.putMany(records); // one atomic write: never half old, half new
      this.sk = sk;
    });
  }

  /** Add a key to the identity (e.g. the account key when upgrading a v0.3 device to primary). */
  addIdentityPart(part, jwkPair) {
    return this.serial(async () => {
      if (!this.sk) throw new VaultError('locked', 'Vault is locked.');
      if (!PARTS[part]) throw new VaultError('bad-part', 'Unknown key type.');
      const record = await this.backend.get('identity');
      const wrapped = await this.wrapIdentity(this.sk, { [part]: jwkPair });
      await this.backend.putMany({ identity: { ...record, ...wrapped } });
      return (await this.unwrapIdentity(this.sk, wrapped))[part];
    });
  }

  /**
   * Decrypt one identity key as a JWK pair, for an encrypted backup. Requires the passphrase
   * when one is set, so an unattended unlocked session cannot export the account key.
   */
  exportIdentityPart(part, passphrase = null) {
    return this.serial(async () => {
      if (!this.sk) throw new VaultError('locked', 'Vault is locked.');
      const meta = await this.meta();
      if (meta.mode === 'passphrase') await this.unwrapStorageKey(meta, passphrase);
      const record = await this.backend.get('identity');
      if (!record[part]) throw new VaultError('missing', 'This device does not hold that key.');
      return (await this.readIdentityJwks(this.sk, { [part]: record[part] }))[part];
    });
  }

  lock() {
    this.sk = null;
  }

  /** Remove everything this vault stored. */
  destroy() {
    return this.serial(async () => {
      await this.backend.putMany({ meta: null, deviceKey: null, identity: null, state: null });
      this.sk = null;
    });
  }
}
