# FabriC++ browser client — design extension (DRAFT, needs user approval)

Status: design only. No browser code. Extends the approved mobile spec
(`2026-11-07-fabric-mobile-design.md`); everything there still applies unless stated here.

## 1. Pinned SDK (evidence from the npm tarball source, read 2026-11-07)
- `matrix-js-sdk@45.0.0` (npm `latest`, published 2026-11-03, repo matrix-org/matrix-js-sdk, `engines.node >=22`).
- It pins `@matrix-org/matrix-sdk-crypto-wasm@18.9.0` (Rust crypto as WASM). We pin exactly this pair;
  crypto-wasm 19.0.1 exists but is not what 45.0.0 is tested with. Lockfile + `npm ci` only; no CDN.
- APIs (file:line in 45.0.0 `src/`):
  - `MatrixClient.initRustCrypto({useIndexedDB, cryptoDatabasePrefix, storageKey, storagePassword})` client.ts:2046.
    Docs, client.ts:2024-2026: `storageKey` "must be exactly 32 bytes ... same each time ... If both this and
    `storagePassword` are unspecified, the store will be unencrypted." `useIndexedDB:false` = in-memory store.
  - `clearStores()` client.ts:1646 (deletes sync store + rust crypto DBs; throws if client running);
    `logout()` 6988; `stopClient()` 1605; `loginWithPassword()` 6905; `setIgnoredUsers()` 2440;
    `reportEvent(roomId, eventId, score, reason)` 8811.
  - CryptoApi (crypto-api/index.ts): `getUserVerificationStatus` 251 (`isCrossSigningVerified`,
    `wasCrossSigningVerified`, `needsUserApproval`), `pinCurrentUserIdentity` 261,
    `withdrawVerificationRequirement` 269, `requestVerificationDM` 528, `requestOwnUserVerification` 542;
    event `CryptoEvent.VerificationRequestReceived`.
  - Sync cache `IndexedDBStore` (store/indexeddb.ts:60) is a separate store and is NOT covered by `storageKey`.

## 2. Trust-model differences from native Android (require explicit user acceptance)
1. **Password, access token, and keys are in JS.** `loginWithPassword` takes the password as a JS string; the
   token and the (wasm) crypto keys live in the page's memory. There is no Keystore/FLAG_SECURE analogue.
   Native "password never enters JS" CANNOT be reproduced in a browser.
   Alternative that avoids typing the password into our page: Matrix OIDC (MAS) login — requires adding
   Matrix Authentication Service to the local server (not in scope now); token still ends up in JS.
2. **Same-origin XSS = full compromise** (read messages, send as user, steal keys). Mitigated only by strict CSP,
   no third-party scripts, React escaping, no `dangerouslySetInnerHTML`, no HTML message rendering. Not
   equivalent to OS keystore isolation.
3. **WebCrypto/IndexedDB is not a Keychain.** Anything persisted is readable by any script on the origin and by
   anyone with the browser profile. `storageKey`/`storagePassword` only encrypt the crypto store; the sync cache
   (room list, plaintext message bodies in timeline cache) would be plaintext in IndexedDB.
4. **No screenshot protection, no secure keyboard**; browser extensions can read the DOM.
5. Requires a secure context (`https:` or `http://localhost`); app refuses to start otherwise (`isSecureContext`).

## 3. Storage and session options (decision required)
Verified in 45.0.0 source: `initRustCrypto` -> `rust-crypto/index.ts:144-149` calls
`StoreHandle.openWithKey(prefix, storeKey)` or `StoreHandle.open(prefix, storePassphrase)` (WASM-side key
derivation, "deliberately slow"), else an unencrypted store. Restore is supported by constructing the client with
the same `userId`/`deviceId`/`accessToken` (`client.ts:1382`, `1392`) and reopening the same store with the same
passphrase/key. **The SDK provides no encryption for the access token**; that is the app's problem.

### Option A — session-only (limited prototype only)
`initRustCrypto({useIndexedDB:false})`, `MemoryStore`, nothing written to browser storage.
**Major drawbacks (not a daily-use messenger):**
- Every load creates a NEW device: device list grows, peers see new devices, each needs fresh trust.
- History sent before that device existed cannot be decrypted (no backup/recovery by spec).
- Closing/reloading the tab does NOT reliably log out: `beforeunload`/`pagehide` handlers may not complete,
  so there is **no guarantee the server session/device is revoked**. Stale devices stay until removed in
  Settings (or by an admin).

### Option B — passphrase-unlocked persistent store (usable option, NOT yet approved)
- Crypto store: IndexedDB opened with `storagePassword` = user passphrase entered each visit (never stored).
- Sync cache: memory-only `MemoryStore` (no plaintext room/message cache on disk); history re-fetched on unlock.
- Access token: must also be encrypted at rest. js-sdk has no supported mechanism. Possible design: WebCrypto
  (PBKDF2/Argon2 derive -> AES-GCM wrap) — this is **custom cryptography and needs a separate review**.
  **Unresolved gate:** until that design is reviewed, Option B cannot ship; nothing (passphrase, key,
  token) may be persisted in plaintext.
- While unlocked, passphrase-derived keys and token are in page memory: still fully XSS-exposed.
- Passphrase entropy: minimum length + strength check; weak passphrases make offline guessing of a copied
  profile feasible. Lost passphrase = local store unrecoverable: sign in as a new device, old history on
  this browser lost, re-verify. No automatic recovery; native cross-signing/key backup stays excluded.
- Auto-lock on idle drops keys/token from memory.

### Recommendation
Release-1 browser = **Option A as a clearly labelled limited prototype**, with explicit "Sign out" as the only
reliable revoke. Option B becomes the daily-use target only after the token-wrapping design is reviewed and
approved. This is a design-acceptance request, not a release-ready or complete claim.

## 4. Features (parity with Android, policy per approved spec §5 and `core/src/rules.ts`)
Send policy is the SAME as mobile (`canSend`): allowed when the room is encrypted and there is no pending
identity change; blocked when encryption is off/unknown (`not_encrypted`, `encryption_unknown`) or a peer's
identity changed and is not yet acknowledged (`identity_changed`). Unverified peers/devices are allowed but
visibly marked "Not verified"; verified peers show "Verified". SAS is offered, not required to send.
- Verification: `requestVerificationDM` (peer), `requestOwnUserVerification` (own device), emoji compare.
- Identity change: `getUserVerificationStatus().needsUserApproval` -> banner, send blocked;
  `pinCurrentUserIdentity` only after the user acknowledges; previously verified -> `wasCrossSigningVerified`
  shown; never silently accepted.
- Offline/catch-up via sync; failed sends shown "failed", retry is manual.
- Block/unblock `setIgnoredUsers`; event report `reportEvent` with disclosure (admins see only ciphertext of
  E2EE content); sign out `logout()` then `clearStores()`.
- Log redaction via `core/src/redact.ts`; no tokens/passwords/keys/bodies in console.
- Revenue: "Not connected", no earnings, per-user revenue authorization not implemented. No backup/recovery.

## 5. UI
Same as mobile: white `#fff`, text `#111820`, blue `#2454dd`, `#d6dce1` dividers, Helvetica/Arial regular,
name "FabriC++", no logo. Reuse `core/` (conversation model, formatting, validation) where it has no RN deps.

## 6. Security headers / hosting
Self-hosted, pinned assets built by Vite; CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval';
connect-src 'self' http://127.0.0.1:8008; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
Synapse CORS limited to the dev origin. localhost only; no public deployment.

## 7. Tests
- Shell (no browser process): unit + integration with real matrix-js-sdk 45.0.0 / crypto-wasm 18.9.0 in Node
  against local Synapse with throwaway users; in-memory DOM tests (jsdom) for screens/redaction/policy.
- Cross-client real E2EE: Node js-sdk client <-> Android SDK instrumentation peer (real ciphertext; verify
  event `m.room.encrypted` on Synapse, decrypt both ways, SAS, identity-change block, block, report).
- Actual browser E2E: performed by the parent via computerUse in a real browser. No Playwright/CDP/browser
  automation from Shell.
- Limits: emulator only, no physical phone; Android GUI runs pending KVM access; no fake ciphertext.

## 8. Status
Draft for design acceptance. Password login in JS (§2) and the storage option (§3) need explicit user
acceptance. No new services (MAS/OIDC) are approved or planned here.
