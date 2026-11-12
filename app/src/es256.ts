// ES256 (ECDSA P-256 + SHA-256) signature check for Cumulus://ID ID tokens. React Native's Hermes
// has no WebCrypto, so this uses the audited pure-JS @noble libraries (MIT).
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlToBytes, type Es256Verify } from "./core/cid";

export const verifyEs256: Es256Verify = async (jwk, signingInput, signature) => {
  if (signature.length !== 64 || !jwk.x || !jwk.y) return false;
  const x = base64urlToBytes(jwk.x);
  const y = base64urlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) return false;
  const publicKey = new Uint8Array(65);
  publicKey[0] = 4;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  // JWS ES256 signatures are raw r||s and may be high-S (WebCrypto signers do not normalise).
  return p256.verify(signature, sha256(new TextEncoder().encode(signingInput)), publicKey, { format: "compact", prehash: false, lowS: false });
};
