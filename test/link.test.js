import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRelay } from '../server/relay.js';
import { qrMatrix } from '../shared/qr.js';
import { generateIdentity, generateSigningKey } from '../shared/crypto.js';
import { encodeLinkCode, linkConfirmCode, newLinkNonce, LINK_NONCE_RE } from '../shared/devices.js';

const jsQR = createRequire(import.meta.url)('jsqr');

/** Render a module matrix the way a camera might see it and read it back with jsQR. */
function decode(m, { scale = 4, quiet = 4 } = {}) {
  const n = (m.length + 2 * quiet) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) {
    if (!m[r][c]) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + quiet) * scale + y) * n + (c + quiet) * scale + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  return jsQR(px, n, n)?.data ?? null;
}

test('QR encoder: every version from 1 to 10 reads back', () => {
  const seen = new Set();
  for (let len = 1; len <= 213; len += len < 20 ? 1 : 9) {
    const text = Array.from({ length: len }, (_, i) => 'FAB1.xY_-9'[i % 10]).join('');
    const m = qrMatrix(text);
    seen.add((m.length - 17) / 4);
    assert.equal(decode(m), text, `length ${len}`);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.throws(() => qrMatrix('x'.repeat(214)), /too long/);
  // UTF-8 survives (device names are not in the code, but the encoder shouldn't care)
  assert.equal(decode(qrMatrix('Grüße 👋')), 'Grüße 👋');
});

test('a real link code fits a small QR code and reads back', async () => {
  const eph = await generateIdentity();
  const code = encodeLinkCode('AbCdEfGhIjKlMnOpQrStUvWx', eph.publicJwk);
  const m = qrMatrix(code);
  assert.ok(m.length <= 45, `version ${(m.length - 17) / 4}`); // version 7 at most
  assert.equal(decode(m, { scale: 3 }), code);
});

test('confirmation number: same on both sides, different under any substitution', async () => {
  const [dev, pri, mitm] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
  const account = (await generateSigningKey()).publicJwk;
  const other = (await generateSigningKey()).publicJwk;
  const nonce = newLinkNonce();
  assert.match(nonce, LINK_NONCE_RE);
  const base = { deviceEph: dev.publicJwk, primaryEph: pri.publicJwk, account, handle: '@amy.veil', nonce };
  const a = await linkConfirmCode(base);
  assert.match(a, /^\d{3} \d{3}$/);
  assert.equal(await linkConfirmCode({ ...base }), a);
  // a relay swapping the primary's key, a swapped code, another account or handle, another nonce
  const variants = [
    { primaryEph: mitm.publicJwk }, { deviceEph: mitm.publicJwk }, { account: other },
    { handle: '@amy2.veil' }, { nonce: newLinkNonce() },
  ];
  for (const v of variants) assert.notEqual(await linkConfirmCode({ ...base, ...v }), a, JSON.stringify(Object.keys(v)));
});

test('relay serves the QR reader from node_modules', async (t) => {
  const relay = await createRelay({ port: 0, dataFile: null, log: () => {}, sfu: null });
  t.after(() => relay.close());
  const res = await fetch(`${relay.url}/vendor/jsqr.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /jsQR/);
});
