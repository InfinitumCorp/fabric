# FabriC++ Full Build Out Progress

**Status as of 2026-11-07:** Core platform-free logic and scaffolding complete. Native Matrix bridge and full screens remaining.

## Completed

### Stage 1 (data-exchange) — InfinitumCorp/infinitum-nexus `feat/full-fabric-buildout` (PR #47)
- Explicit consent required before packaging any dataset
- Revoke delists immediately
- FABRIC contributor share 70% (others remain 85%)
- Tests: 16/16 pass on `@infinitum/data-exchange`

### Stage 4 (client core) — this repo `app/src/core/`
- Fail-closed send rules (`canSend`)
- Message rendering and status transitions
- Log redaction (user ids, tokens, bodies)
- Brand theme tokens (paper/ink/muted/line/accent, FabriC++)
- Revenue client: entitlements, consent grant/withdraw, earnings; payments disabled (throws `PaymentsDisabledError`)
- Tests green with Node 22 (`node --test --experimental-strip-types app/src/core/*.test.ts`)

### Stage 2 scaffolding
- `server/docker-compose.yml` for local Synapse v1.164.2 + Postgres 16
- Closed registration, federation off (config via generate + patch)

### App shell
- Basic Expo app (`app/App.tsx`) with branding
- `package.json` with Expo 58 targets

## Remaining for full build out

1. **Stage 2 runtime** — requires Docker: run compose, generate config, verify encrypted event storage, registration closed, federation off.
2. **Stage 3 native bridge spike** — Expo module wrapping matrix-rust-sdk (Swift/Kotlin bindings). Requires Android SDK + emulator and Mac + Xcode. Pin matching SDK commits.
3. **Stage 5 screens** — chat list, conversation, SAS verification, block/report, Plan/Data revenue UI on the verified bridge API. Two-device sign-off.
4. **Integration** — Matrix login against local Synapse, encrypted store key in Keychain/Keystore, offline queue, fail-closed E2EE.

## Run core tests

```sh
cd app
node --test --experimental-strip-types src/core/*.test.ts
```

No merges, no public deploy, no spend. See `docs/` for full design spec and plan index (from infinitum-nexus PR #23).
