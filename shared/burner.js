// Burner numbers: disposable phone numbers that stand in for you on calls and texts. This file is the
// record shared with ÆTHER (same fields, same meaning), bundle pricing, and the small rules both
// sides follow. FABRIC keeps the full records in the encrypted vault on the device; the relay only
// knows which number routes to which account.
//
// Record (v1):
//   { v: 1, id, network: 'pstn' | 'aether-mesh', number, label, scope: 'general' | 'dedicated',
//     state: 'active' | 'rotating' | 'burned', createdAt, burnedAt, rotatedFrom, bundleId }
//   id           128 random bits, base64url
//   number       E.164 for 'pstn' (+15551234567); for 'aether-mesh' exactly 10 digits, derived by
//                ÆTHER from the device key (shown there as "ÆN 733 482 9173")
//   state        'rotating' only while a replacement is being set up (ÆTHER); FABRIC rotates in one step
//   createdAt, burnedAt  epoch milliseconds; burnedAt is set exactly when state is 'burned'
//   rotatedFrom  id of the record this one replaced, or null
//   bundleId     the add-on bundle it counts against, or null

export const BURNER_V = 1;
export const BUNDLES = [1, 2, 5];
export const NETWORKS = ['pstn', 'aether-mesh'];
export const SCOPES = ['general', 'dedicated'];
export const E164 = /^\+[1-9]\d{6,14}$/;
const MESH = /^\d{10}$/;
const ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_LABEL = 40;

export function validNumber(network, number) {
  return network === 'pstn' ? E164.test(String(number)) : network === 'aether-mesh' ? MESH.test(String(number)) : false;
}

const randomId = () => {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const cleanLabel = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, MAX_LABEL);

export function newBurner({ number, network = 'pstn', label = '', scope = 'general', bundleId = null, rotatedFrom = null, now = Date.now(), id = randomId() }) {
  const r = { v: BURNER_V, id, network, number, label: cleanLabel(label), scope, state: 'active', createdAt: now, burnedAt: null, rotatedFrom, bundleId };
  if (!validBurner(r)) throw new Error('invalid burner number');
  return r;
}

export function validBurner(r) {
  if (!r || r.v !== BURNER_V || !ID.test(r.id || '') || !NETWORKS.includes(r.network) || !validNumber(r.network, r.number)) return false;
  if (typeof r.label !== 'string' || r.label.length > MAX_LABEL || !SCOPES.includes(r.scope)) return false;
  if (!Number.isFinite(r.createdAt)) return false;
  if (r.state !== 'burned' && r.burnedAt !== null) return false;
  if (r.state === 'burned' && !(Number.isFinite(r.burnedAt) && r.burnedAt >= r.createdAt)) return false;
  if (!['active', 'rotating', 'burned'].includes(r.state)) return false;
  if (r.rotatedFrom !== null && !ID.test(r.rotatedFrom)) return false;
  if (r.bundleId !== null && !(typeof r.bundleId === 'string' && r.bundleId.length <= 64)) return false;
  return true;
}

export const burn = (r, now = Date.now()) => (r.state === 'burned' ? r : { ...r, state: 'burned', burnedAt: Math.max(now, r.createdAt) });

/** Rotating: the old record is burned and a new one takes its label, scope and bundle. */
export function rotate(r, number, now = Date.now()) {
  return [burn(r, now), newBurner({ number, network: r.network, label: r.label, scope: r.scope, bundleId: r.bundleId, rotatedFrom: r.id, now })];
}

/**
 * Brings the device's records in line with the numbers the relay says are this account's:
 * a number the relay no longer routes is burned here too; a new one gets a record.
 */
export function reconcile(records, lines, now = Date.now()) {
  const live = new Set(lines.map((l) => l.number));
  const out = records.filter(validBurner).map((r) => (r.network === 'pstn' && r.state === 'active' && !live.has(r.number) ? burn(r, now) : r));
  for (const l of lines) {
    if (!out.some((r) => r.state === 'active' && r.number === l.number)) {
      // a line made on another device, or after a rotate there
      const prev = out.find((r) => r.state === 'burned' && r.id && l.rotatedFrom && r.number === l.rotatedFrom);
      out.push(newBurner({ number: l.number, now: l.createdAt || now, label: prev?.label || '', scope: prev?.scope || 'general', rotatedFrom: prev?.id || null, bundleId: l.bundleId || null }));
    }
  }
  return out;
}

/** Which of your numbers a conversation with `peer` uses: the one you chose, else your main number. */
export function lineFor(records, byPeer, peer) {
  const id = byPeer?.[peer];
  const r = id && records.find((x) => x.id === id && x.state === 'active');
  return r || null;
}
