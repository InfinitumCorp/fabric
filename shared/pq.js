// ML-KEM-768 (FIPS 203) for the post-quantum part of session setup, from @noble/post-quantum
// (MIT, Paul Miller; see THIRD_PARTY_NOTICES.md). In Node it comes from node_modules; in the
// browser the relay serves the same files under /vendor/noble/, so pages load no third-party script.

const inBrowser = typeof globalThis.document !== 'undefined' || typeof globalThis.WorkerGlobalScope !== 'undefined';
const spec = inBrowser ? '/vendor/noble/post-quantum/ml-kem.js' : '@noble/post-quantum/ml-kem.js';
const { ml_kem768: kem } = await import(spec);

export const KEM = 'ML-KEM-768';
export const PUBLIC_KEY_BYTES = 1184;
export const CIPHERTEXT_BYTES = 1088;

/** A fresh ML-KEM-768 key pair: { publicKey, secretKey } as Uint8Arrays. */
export const kemKeygen = () => kem.keygen();

/** Encapsulate to a public key: { cipherText, sharedSecret } (32 bytes). */
export const kemEncapsulate = (publicKey) => kem.encapsulate(publicKey);

/** Decapsulate. ML-KEM never throws on a wrong ciphertext: it returns an unrelated secret (implicit rejection). */
export const kemDecapsulate = (cipherText, secretKey) => kem.decapsulate(cipherText, secretKey);
