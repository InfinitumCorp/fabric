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

## 3. Recommended default (Option A): session-only, nothing persisted
- `initRustCrypto({useIndexedDB:false})` and in-memory `MemoryStore`; no localStorage/IndexedDB/cookies.
- Each tab load = new device: login, then must verify against an existing trusted device (SAS) before
  sending, same fail-closed rule as Android. Tab close/reload loses the session → `logout()` on unload where
  possible; stale devices are listed in Settings for removal.
- UX cost: reverify every visit; history before the device existed is unreadable (no backup, by spec).
- Option B (not default; needs separate approval): persistent IndexedDB crypto store with `storagePassword`
  entered each visit (never stored), sync cache kept in memory only, auto-lock on idle. Still exposed to XSS
  while unlocked; passphrase is in JS.

## 4. Features (parity with Android)
Chat list, new chat (DM), conversation with fail-closed send, contact with SAS verification
(`requestVerificationDM`, emoji compare), own-device verification (`requestOwnUserVerification`),
identity change banner (`needsUserApproval` → `pinCurrentUserIdentity` only after user acknowledges; never
silent), offline/catch-up (sync resumes; queued sends not auto-resent without verified state), block/unblock
(`setIgnoredUsers`), event report (`reportEvent`, disclosure: admins see only ciphertext of E2EE content),
sign out (`logout` + `clearStores`). Log redaction: no tokens, passwords, keys or message bodies in console;
SDK logger level capped and filtered. Revenue/payments: "Not connected" only; no earnings shown;
per-user revenue authorization does not exist. No backup/recovery.

## 5. UI
Same as mobile: white `#fff`, text `#111820`, blue `#2454dd`, `#d6dce1` dividers, Helvetica/Arial regular,
name "FabriC++", no logo. Reuse `core/` (conversation model, formatting, validation) where it has no RN deps.

## 6. Security headers / hosting
Self-hosted, pinned assets built by Vite; CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval';
connect-src 'self' http://127.0.0.1:8008; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
Synapse CORS limited to the dev origin. localhost only; no public deployment.

## 7. Tests
- Unit: core reuse, CSP present, no persistent storage writes (Option A), redaction filter.
- Cross-client real E2EE on local Synapse with throwaway users: Android SDK (instrumentation) <-> browser
  (Playwright, headless Chromium, localhost) send/receive, SAS both directions, identity-change banner, block,
  report reaches Synapse admin API as ciphertext event. No fake ciphertext.
- Limits: emulator only (no physical phone); Android GUI runs pending KVM access.
