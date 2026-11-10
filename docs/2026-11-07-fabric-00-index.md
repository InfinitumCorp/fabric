# FabriC++ mobile: plan index and build order

Spec: `docs/superpowers/specs/2026-11-07-fabric-mobile-design.md` (approved in PR #23, commit 3810e36).

This index orders five stages. Each stage has its own plan, its own tests and can be reviewed on its own. A stage starts only when the gate of the stage before it has passed with recorded evidence.

| Stage | Plan | Builds | Runs on | Gate to pass |
|---|---|---|---|---|
| 1 | `2026-11-07-fabric-01-data-exchange-consent.md` | Fix automatic consent and the 85% vs 70% FABRIC share in `packages/data-exchange`, with regression tests | Linux box (Node 24, pnpm 10.28) | `pnpm -r test` and `pnpm -r typecheck` green |
| 2 | `2026-11-07-fabric-02-synapse-local.md` | Local Synapse + PostgreSQL compose, closed registration, federation off, a check that stored events are encrypted | Any machine with Docker | Server checks script passes |
| 3 | `2026-11-07-fabric-03-native-bridge-spike.md` | Expo app shell and a local native module that builds a Matrix client with an encrypted store key held in Keychain / Keystore, and logs in | Android: machine with Android SDK + emulator. iOS: a Mac with Xcode | Spike checklist passes on both an Android emulator and an iOS simulator |
| 4 | `2026-11-07-fabric-04-client-core.md` | Platform-free TypeScript core: fail-closed send rules, message status, logout cleanup contract, revenue API client for entitlements, consent and earnings | Linux box | Unit tests green |
| 5 | Screens and full bridge (written after Stage 3) | Chat list, conversation, verification, block/report, Plan and Data revenue screens on the verified bridge API | Android + iOS devices | Two-device sign-off list in the spec, section 14 |

Stage 5 is deliberately not written yet. Its exact bridge calls depend on what Stage 3 proves works with the pinned SDK release; writing it now would mean guessing APIs.

## Pinned versions (checked 2026-11-07, re-check at Stage 3 start)

| Component | Version | Source |
|---|---|---|
| Swift bindings `matrix-rust-components-swift` | `26.10.27`, built from matrix-rust-sdk commit `e675036b27be102b05ec5c5bff843cf8d739338c` | https://github.com/matrix-org/matrix-rust-components-swift/releases |
| Kotlin bindings `org.matrix.rustcomponents:sdk-android` | Maven Central has `26.10.15`, `26.10.20`, `26.10.23`, `26.11.05`; no `26.10.27` | https://repo1.maven.org/maven2/org/matrix/rustcomponents/sdk-android/maven-metadata.xml |
| Synapse | `v1.164.2` (2026-11-02), image `matrixdotorg/synapse:v1.164.2` | https://github.com/element-hq/synapse/releases |
| Expo SDK | `expo@58.0.23`; `expo-secure-store` recommended `~58.0.2`; `expo-dev-client@58.0.18` | npm registry |

The Swift and Kotlin bindings are published on different date tags. Stage 3 Task 1 must pick a pair built from the same matrix-rust-sdk commit (read each release's linked commit) or record the API differences between the two. This is a gate, not an assumption.

## Facts verified in source (pinned commit e675036)

- `ClientBuilder.new()`, `.homeserver_url(url)`, `.sqlite_store(SqliteStoreBuilder)`, `.build()` (async): `bindings/matrix-sdk-ffi/src/client_builder.rs`.
- `SqliteStoreBuilder.new(data_path, cache_path)`, `.key(Option<Vec<u8>>)`, `.passphrase(..)`, `.high_entropy_passphrase(..)`: `bindings/matrix-sdk-ffi/src/store.rs`.
- `Client.login(username, password, initial_device_name, device_id)`, `user_id()`, `device_id()`, `logout()`: `bindings/matrix-sdk-ffi/src/client.rs`.
- At-rest encryption: `matrix-sdk-sqlite` uses plain `rusqlite` (no SQLCipher) plus `matrix-sdk-store-encryption`, which encrypts stored values when a key or passphrase is supplied (`crates/matrix-sdk-sqlite/Cargo.toml`, `src/lib.rs`). It is value-level encryption, not whole-file encryption. Without a key the store is not encrypted. The plan therefore (a) always passes a 32-byte key via `.key(..)`, the raw-key form of the spec's "high-entropy passphrase", and (b) also relies on OS file protection. Stage 3 includes a check that the SQLite file contains no test plaintext.

## Decisions and blockers for the owner

1. One repo per build (`InfinitumCorp/RULES`, rule 5) conflicts with the spec's location `apps/fabric-mobile` inside `infinitum-nexus`. Stage 1 and Stage 4 belong in Nexus either way. Before Stage 3 starts, choose: a new private repo `InfinitumCorp/fabric` for the app and server config (consistent with RULES), or Nexus as the spec says. Plans 2 and 3 use the path prefix `<app-repo>/` for this reason.
2. Revenue API sign-in for phones: `infinitum-revenue` authenticates organisations (`c.get("org")` on `/v1/*`); it has no per-user mobile token. A mapping from Matrix account to revenue account and a mobile token must be added to `infinitum-revenue` before Stage 5 uses live entitlements. Stage 4 builds the client against a fake.
2a. Earnings detail: `GET /v1/earnings` returns only `{ availableCents, pendingCents }`. The per-sale ledger view in spec section 10.5 (sale, eligible revenue, 70% amount, hold release date) needs a new read endpoint in `infinitum-revenue`. Until then the app shows only those two real totals.
3. The FABRIC++ domain is `infinitumfabric.app`, hosted at Cloudflare (spec sections 11 and 13). Apple and Google developer accounts, in-app purchase vs web checkout, live Stripe and payouts, counsel review of data revenue, and revenue API hosting remain open. None of those is needed for Stages 1–4.
4. Licensing review (not a legal conclusion): Synapse is AGPL-3.0-or-later or Element commercial; running modified Synapse as a service has source-offer duties, so Stage 2 uses the unmodified image and config only. Matrix Rust SDK and both bindings are Apache-2.0. Expo and React Native are MIT. ÆTHER code is not used.

## Tooling limits on this box

The Linux box has Node 24.22.1 and pnpm 10.28.0. It has no Docker, no Android SDK and no Xcode. Stages 1 and 4 can run here. Stage 2 needs Docker. Stage 3 needs Android Studio for Android and a Mac for iOS; no iOS result may be reported from this box.

## Spec coverage

| Spec section | Where |
|---|---|
| 1 Goal / scope | All stages; screens in Stage 5 |
| 2 No custom crypto, scaffold not on secure path | Stage 3 Task 2 (SDK only), Stage 4 Task 2 (test that fails on any `@infinitum/fabric` import) |
| 3 Architecture, FFI API table | Stage 3 |
| 4 Key management, at-rest, fail closed, iOS stale Keychain | Stage 3 Tasks 2–4 |
| 5 Encryption policy (fail-closed send, UTD, identity change) | Stage 4 Task 1 (rules), Stage 5 (wiring) |
| 6 Logging redaction | Stage 4 Task 2 |
| 7 Server config, metadata limits | Stage 2 |
| 8 Block / report | Stage 5 |
| 9 Interface tokens | Stage 4 Task 2 (theme), Stage 3 Task 4 (spike screen), Stage 5 |
| 10.1–10.2 Monetization source and blockers | Stage 1 |
| 10.3–10.6 Entitlements, consent, earnings, backend split | Stage 4 Tasks 3–4; revenue mobile auth and per-sale earnings view are blockers 2 and 2a |
| 11 External dependencies | This index, decisions |
| 12 Implementation gates | Stage 3 Task 1 (versions), Stage 1 (monetization gate), Stage 3 (bridge spike) |
| 14 Tests: negative cases | Stages 1, 2, 3, 4; device sign-off in Stage 5 |

Plan checks done while writing (throwaway copies, nothing committed): Stage 1 code applied to `main` gave 394 tests, 0 failures, typecheck clean; Stage 4 code ran 11 tests, 0 failures on Node 24. Stages 2 and 3 have not been run (no Docker, Android SDK or Xcode on this box).

Mocks vs real: Stage 4 tests use fakes and prove logic only. Stage 3 proves the SDK on emulator/simulator. Only the Stage 5 two-device list counts as device sign-off.
