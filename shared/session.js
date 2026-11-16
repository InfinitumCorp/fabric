// Session bookkeeping on top of ratchet.js: one or more ratchet sessions per contact,
// prekey lifecycle, and strictly serialized operations (ratchet state must never be
// advanced by two operations at once).
//
// Sessions are per device: peers are addressed as "@name.veil#<deviceId>".
// `store` is a plain JSON object the caller persists after every operation:
//   { sessions: { [address]: [state, ...] }, prekeys: { spks, opks, nextSpkId, nextOpkId },
//     pq: { [address]: pinnedAt } }   devices that have used post-quantum setup with us

import { newMessageId, sameIdentity, privateOf } from './crypto.js';
import { deviceAddr, parseAddr } from './devices.js';
import {
  initiateSession, acceptSession, ratchetEncrypt, ratchetDecrypt,
  generateSignedPreKey, generateOneTimePreKeys, publicPreKeys,
} from './ratchet.js';

export const MAX_SESSIONS_PER_PEER = 3;
export const SPK_ROTATE_MS = 7 * 24 * 3600 * 1000;
export const SPK_KEEP = 2; // keep the previous signed prekey for in-flight session setups
export const OPK_TARGET = 50;
export const OPK_LOW = 15;
export const PQ_RECHECK_MS = 24 * 3600 * 1000; // how often a classical session looks for a PQ upgrade

export const routingOf = ({ id, from, fromDevice, to, toDevice, ts }) => `${id}|${from}#${fromDevice}|${to}#${toDevice}|${ts}`;

export function emptyStore() {
  return { sessions: {}, prekeys: { spks: {}, opks: {}, nextSpkId: 1, nextOpkId: 1 } };
}

export class SessionManager {
  /**
   * @param {object} o
   * @param {string} o.handle            my @name.veil
   * @param {string} o.deviceId          this device's id
   * @param {object} o.identity          my full identity key pairs { dh, sig }
   * @param {object} o.store             persisted JSON (see top of file)
   * @param {(peer) => Promise<object>} o.fetchBundle  relay bundle lookup
   * @param {() => void} [o.onChange]    called after the store changes; persist it there
   */
  constructor({ handle, deviceId, identity, store, fetchBundle, onChange = () => {} }) {
    Object.assign(this, { handle, deviceId, identity, store, fetchBundle, onChange });
    this.addr = deviceAddr(handle, deviceId);
    this.queue = Promise.resolve();
  }

  /** Run fn after every earlier operation has finished. */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---------- prekeys ----------
  /** Rotate the signed prekey if due and top up one-time prekeys. Returns what to upload, or null. */
  maintainPreKeys(serverOpkCount, { forceSpk = false } = {}) {
    return this.serial(async () => {
      const pk = this.store.prekeys;
      const spks = Object.values(pk.spks).sort((a, b) => b.createdAt - a.createdAt);
      let current = spks[0];
      let changed = false;
      // a signed prekey from before v3 has no post-quantum half: replace it now rather than in a week
      if (!current || !current.pq || Date.now() - current.createdAt > SPK_ROTATE_MS) {
        current = await generateSignedPreKey(privateOf(this.identity.sig), pk.nextSpkId++);
        pk.spks[current.id] = current;
        for (const old of spks.slice(SPK_KEEP - 1)) delete pk.spks[old.id];
        changed = true;
      }
      let fresh = [];
      if (serverOpkCount < OPK_LOW) {
        fresh = await generateOneTimePreKeys(pk.nextOpkId, OPK_TARGET - serverOpkCount);
        pk.nextOpkId += fresh.length;
        for (const k of fresh) pk.opks[k.id] = k;
        changed = true;
      }
      if (!changed && !forceSpk) return null;
      this.onChange();
      return publicPreKeys(current, fresh);
    });
  }

  // ---------- post-quantum pinning ----------
  // Once a device has used a v3 (post-quantum) session with us, it is pinned: later setups with it
  // must be v3 too, so a relay that strips PQ keys from bundles or setup messages gets an error,
  // not a quiet downgrade. (The very first contact cannot be protected this way.)
  pqPinned(addr) {
    return Boolean(this.store.pq?.[addr]);
  }

  pinIfPq(addr, state) {
    if (state.v !== 3 || this.pqPinned(addr)) return;
    (this.store.pq ??= {})[addr] = Date.now();
  }

  /**
   * A classical (v2) session from before this device or the peer had post-quantum keys: at most
   * once a day, look at the peer's current bundle and, if it now has a PQ prekey, start a v3
   * session to send on. The old session stays in the list for messages still in flight.
   * Returns the new state, or null (no PQ key yet, or checked recently, or the lookup failed).
   */
  async upgradeToPq(peer) {
    const checked = (this.store.pqChecked ??= {});
    if (Date.now() - (checked[peer] || 0) < PQ_RECHECK_MS) return null;
    checked[peer] = Date.now();
    try {
      const bundle = await this.fetchBundle(peer);
      if (!bundle?.spk?.pq) return null;
      return await initiateSession({ myHandle: this.addr, myIdentity: this.identity, peerHandle: peer, bundle, requirePq: true });
    } catch {
      return null; // keep sending on the working session; try again tomorrow
    }
  }

  /** Post-quantum status of the newest session with a device: 'pq', 'classic' or null. */
  sessionKind(addr) {
    const s = this.store.sessions[addr]?.[0];
    return s ? (s.v === 3 ? 'pq' : 'classic') : null;
  }

  // ---------- messaging ----------
  hasSession(addr) {
    return Boolean(this.store.sessions[addr]?.some((s) => s.CKs));
  }

  /** Drop sessions: one device address, or every device of a handle. */
  reset(target) {
    return this.serial(async () => {
      for (const a of Object.keys(this.store.sessions)) {
        if (a === target || parseAddr(a).handle === target) delete this.store.sessions[a];
      }
      this.onChange();
    });
  }

  /** Encrypt a payload for one device; starts a session from its prekey bundle if needed. */
  encrypt(peer, payload, { id = newMessageId(), ts = Date.now() } = {}) {
    return this.serial(async () => {
      let list = this.store.sessions[peer] || [];
      let idx = list.findIndex((s) => s.CKs);
      let state;
      if (idx < 0) {
        const bundle = await this.fetchBundle(peer);
        state = await initiateSession({ myHandle: this.addr, myIdentity: this.identity, peerHandle: peer, bundle, requirePq: this.pqPinned(peer) });
      } else {
        state = list[idx];
        if (state.v !== 3) state = (await this.upgradeToPq(peer)) || state;
      }
      const { handle: to, deviceId: toDevice } = parseAddr(peer);
      const meta = { id, from: this.handle, fromDevice: this.deviceId, to, toDevice, ts };
      const out = await ratchetEncrypt(state, payload, routingOf(meta));
      list = list.filter((s) => s !== state);
      this.store.sessions[peer] = [out.state, ...list].slice(0, MAX_SESSIONS_PER_PEER);
      this.pinIfPq(peer, out.state);
      this.onChange();
      return { ...meta, header: out.header, ct: out.ct };
    });
  }

  /**
   * Decrypt an envelope from `peerIdentity`: the sending device's public {dh, sig}, taken from
   * its account's verified device list.
   * Throws if nothing can open it; the store is untouched in that case.
   */
  decrypt(envelope, peerIdentity) {
    return this.serial(async () => {
      const peer = deviceAddr(envelope.from, envelope.fromDevice);
      const routing = routingOf(envelope);
      const list = this.store.sessions[peer] || [];
      const pre = envelope.header?.pre;

      // existing sessions first (a setup message may be a resend on a session we already have)
      const candidates = pre ? list.filter((s) => s.ek === `${pre.ek?.x}.${pre.ek?.y}`) : list;
      for (const s of candidates) {
        if (!sameIdentity(s.peerIdentity, peerIdentity)) continue;
        try {
          const out = await ratchetDecrypt(s, envelope.header, envelope.ct, routing);
          this.store.sessions[peer] = [out.state, ...list.filter((x) => x !== s)];
          this.pinIfPq(peer, out.state);
          this.onChange();
          return out.payload;
        } catch { /* try the next one */ }
      }
      if (!pre) throw new Error('no session could decrypt this message');

      // new session set up by the peer
      const { state, usedOpkId } = await acceptSession({
        myHandle: this.addr, myIdentity: this.identity, prekeys: this.store.prekeys,
        peerHandle: peer, peerIdentity, pre, requirePq: this.pqPinned(peer),
      });
      const out = await ratchetDecrypt(state, envelope.header, envelope.ct, routing);
      if (usedOpkId != null) delete this.store.prekeys.opks[usedOpkId]; // one-time means one time
      this.store.sessions[peer] = [out.state, ...list].slice(0, MAX_SESSIONS_PER_PEER);
      this.pinIfPq(peer, out.state);
      this.onChange();
      return out.payload;
    });
  }
}
