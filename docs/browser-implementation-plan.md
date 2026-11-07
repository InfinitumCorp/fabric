# Browser client implementation plan (DRAFT, starts only after design approval)
1. `web/` Vite + React + TS; pin matrix-js-sdk 45.0.0, crypto-wasm 18.9.0; `npm ci`; assets self-hosted.
2. Secure-context gate + CSP meta/header; dev server bound to 127.0.0.1.
3. Session engine (Option A): login, `initRustCrypto({useIndexedDB:false})`, sync, logout+clearStores.
   Test: storage audit shows no IndexedDB/localStorage after login.
4. Screens from mobile spec, white/logo-free; reuse `core/`.
5. Fail-closed send + own-device verification + peer SAS + identity-change acknowledge.
6. Block/unblock, event report with disclosure, offline catch-up.
7. Log redaction filter + tests.
8. Cross-client tests: Android instrumentation peer <-> Playwright browser on local Synapse.
9. Draft PR; no deploy.
Open user decisions: accept trust model (§2); Option A vs B; password login vs adding MAS/OIDC later.
