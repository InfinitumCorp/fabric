# Browser client implementation plan (DRAFT, starts only after design approval)
1. `web/` Vite + React + TS; pin matrix-js-sdk 45.0.0, crypto-wasm 18.9.0; `npm ci`; assets self-hosted.
2. Secure-context gate + CSP meta/header; dev server bound to 127.0.0.1.
3. Session engine (Option A prototype): login, `initRustCrypto({useIndexedDB:false})`, sync, explicit logout+clearStores.
   Test (jsdom/Node): no storage writes. Option B only after token-wrap design review.
4. Screens from mobile spec, white/logo-free; reuse `core/`.
5. Fail-closed send + own-device verification + peer SAS + identity-change acknowledge.
6. Block/unblock, event report with disclosure, offline catch-up.
7. Log redaction filter + tests.
8. Node js-sdk <-> Android instrumentation real-E2EE tests via Shell; real-browser E2E by parent computerUse only.
9. Draft PR; no deploy.
Open user decisions: accept trust model incl. password in JS (§2); Option A prototype now, Option B gated on token-wrap review (§3).
