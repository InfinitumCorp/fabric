# @fabric/core

Platform-free rules for the FabriC++ app (Stage 4 of the plan in infinitum-nexus PR #23). No React Native, no native code, no network calls of its own.

| File | What it does |
|---|---|
| `rules.ts` | Fail-closed send check (encrypted, known state, no pending identity change), message status, "Unable to decrypt" |
| `redact.ts` | Removes Matrix user ids, access tokens, bearer tokens, bodies, passwords and keys from log lines |
| `theme.ts` | White background, ink `#111820`, muted `#52606b`, line `#d6dce1`, accent `#2454dd`, "FabriC++". No logo |
| `revenue.ts` | Client for infinitum-revenue: FABRIC plan, data-licensing consent grant/withdraw, available/pending earnings in USD. Checkout and payouts always refuse. Takes a token provider; holds no keys |
| `usage.ts` | Daily message counts and session seconds, only while consent is on; numbers and a date only |
| `bridge.ts` | Contract for the native Matrix module. Only a placeholder that refuses every call exists; it reports `encryptedMessaging: false` |

This package does not send, store or encrypt messages. Encrypted messaging arrives with the native module (Stage 3) and is not claimed until its checklist passes on devices.

```
npm ci && npm run typecheck && npm test
```
