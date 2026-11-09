# FabriC++ mobile (Android + iPhone): design spec

- Date: 2026-11-07
- Status: Draft for review. No implementation until this spec is approved.
- Scope owner decisions: shared Android/iPhone app, Matrix end-to-end encryption, self-hosted Synapse backend (approved 2026-11-07); monetization built in according to repo notes (2026-11-07). Domain: `infinitumfabric.app`, hosted at Cloudflare.

## 1. Goal

Real end-to-end encrypted 1:1 text messaging between Android and iPhone, with the backend it needs.

In scope for release 1:

- Sign-in to a closed (invite/token-only) Synapse homeserver
- Chat list and 1:1 conversation view, text only
- End-to-end encryption on every conversation, fail-closed
- Device verification (emoji/SAS) and identity-change warnings
- Encrypted local storage; keys and store secret in Keychain / Keystore
- Offline send queue with visible status and retry
- Block (ignore) and report
- Logout with local cleanup
- Monetization per repo notes (section 10): plan entitlements (Personal free, Business per seat), opt-in data revenue with consent and revocation, USD earnings ledger. Live charges and payouts stay disabled until separately approved and configured.

Out of scope for release 1: voice, video, files, groups, AI features, token ($FAB) payouts or swaps, live Stripe charges and payouts, burner numbers and PSTN/bridge minutes (not sellable until implemented), ÆTHER mesh transport, push notifications, server-side key backup/recovery, federation, CID sign-in, Spectre logging, public deployment, store submission.

## 2. Non-goals and honesty rules

- No custom cryptography. All message encryption comes from the Matrix Rust SDK (vodozemac Olm/Megolm).
- `packages/fabric` (base64 `encrypt`, Node-only `aead.ts`) is a scaffold. It must not be imported anywhere on the secure path and must not be described as secure.
- The app and docs must not claim the server hides metadata. See section 7.
- Library versions are pinned only after an implementation gate verifies them together (section 12). This spec names APIs, not "latest" versions.

## 3. Architecture

```
React Native UI (Expo, TypeScript)
        |  typed JS API (no key material crosses this boundary)
Local Expo module: fabric-matrix  (Swift on iOS, Kotlin on Android)
        |
Matrix Rust SDK FFI bindings
  iOS:     matrix-rust-components-swift (SwiftPM)
  Android: org.matrix.rustcomponents:sdk-android (Maven Central)
        |  HTTPS (TLS required outside local dev)
Synapse homeserver + PostgreSQL (self-hosted)
```

- App shell: Expo with a development build (`expo-dev-client`). Expo Go cannot load the custom native module, so it is not supported.
- Bridge: one local Expo module (`modules/fabric-matrix`) written with the Expo Modules API, wrapping the FFI `Client`, `SyncService`, `RoomListService`, `Timeline`, `Encryption` and `SessionVerificationController`.
- The JS layer receives only display data (room ids, sender ids, decrypted text for rendering, statuses). Keys, store secrets and access tokens stay native.
- Location in repo: `apps/fabric-mobile` (app) and `infra/fabric-synapse` (local dev compose). `packages/fabric` is left as is.
- Public domain: `infinitumfabric.app`, hosted at Cloudflare. Local development stays on localhost.
- Feasibility risk: the FFI bindings are generated with UniFFI and documented by upstream as unstable between releases. Element X (iOS/Android) is the reference consumer. The bridge must stay thin so upgrades touch one module.

FFI APIs confirmed in `matrix-rust-sdk/bindings/matrix-sdk-ffi` on main (2026-11-07):

| Need | FFI API |
| --- | --- |
| Persistent store with at-rest encryption | `ClientBuilder.sqlite_store(SqliteStoreBuilder)`, `SqliteStoreBuilder.new(data_path, cache_path)`, `.passphrase(..)` / `.high_entropy_passphrase(..)` |
| Login / logout | `Client.login(..)`, `Client.logout()` |
| Encryption state, recovery, identities | `Client.encryption()` |
| Device verification (SAS/emoji) | `SessionVerificationController`: `request_device_verification`, `request_user_verification`, `start_sas_verification`, `approve_verification`, `decline_verification`, `cancel_verification` |
| Identity change detection | `IdentityStatusChange { user_id, changed_to: IdentityState }` |
| Offline send queue | `Client.enable_all_send_queues(..)` plus timeline send states |
| 1:1 room creation | `Client.create_room(CreateRoomParameters)` |
| Block | `Client.ignore_user(user_id)` |

Each row must be re-verified against the pinned release at the implementation gate.

## 4. Key management and at-rest encryption

Do not assume the SDK cache is encrypted by default. It is encrypted only when a passphrase/key is supplied.

1. On first sign-in the native module generates a 32-byte random store key with the platform CSPRNG (`SecRandomCopyBytes` / `SecureRandom`).
2. The key is stored:
   - iOS: Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable.
   - Android: wrapped by an Android Keystore AES key (StrongBox when available), stored in app-private storage.
3. The SQLite store is opened with `SqliteStoreBuilder.high_entropy_passphrase(key)`. Never a human-chosen passphrase.
4. If the key is missing or the store fails to open, the app does not fall back to an unencrypted or in-memory store with real data. It signs the user out locally and shows a clear error.
5. Access tokens are held in the same encrypted store or Keychain/Keystore, never in AsyncStorage or JS.
6. iOS Keychain items can survive uninstall. On first launch after install, the app detects missing app data and deletes stale Keychain entries before sign-in.
7. No automatic key backup or recovery in release 1. Losing all signed-in devices means losing message history. Any later backup/recovery needs its own design.

## 5. Encryption policy (fail-closed)

- Every 1:1 room is created with `m.room.encryption` (`m.megolm.v1.aes-sha2`). The app never creates or sends into an unencrypted room. If a room is unencrypted or its encryption state is unknown, sending is disabled.
- Messages that cannot be decrypted show "Unable to decrypt" with no content. No plaintext fallback.
- Unverified devices: allowed to message but visibly marked. Each conversation shows the peer's verification state.
- Identity change: if a verified peer's identity changes (`IdentityStatusChange`), sending to that peer is blocked until the user acknowledges the change or re-verifies.
- Verification uses SAS emoji comparison between two devices. QR verification is optional and may come later.

## 6. Logging and privacy in the client

- No message bodies, keys, tokens, passphrases, or full user ids in logs, crash reports or analytics. Release builds log at warn level or higher, with redaction.
- No third-party analytics or crash reporting in release 1.
- Screens with message content set secure-window flags where the platform supports it (Android `FLAG_SECURE`, configurable).

## 7. Server, relay and metadata limits

The server never receives plaintext message bodies or private keys. It does see and store:

- Account ids, device ids and device public keys
- Room membership (who talks to whom), event timestamps, event sizes and counts
- Client IP addresses and user agents
- Read receipts and typing state, unless disabled in the client

The UI and docs say "messages are end-to-end encrypted", not "metadata is hidden".

Synapse configuration for release 1:

- `enable_registration: false`; accounts are created by an admin or with registration tokens.
- Federation off: `federation_domain_whitelist: []`, and no federation listener exposed.
- PostgreSQL database (not SQLite).
- Local development: Docker Compose with Synapse and PostgreSQL, plain HTTP on localhost only.
- Any non-local environment: TLS required.
- Server logs at INFO or above; access-log retention period to be decided with hosting.

The domain is `infinitumfabric.app`, hosted at Cloudflare (section 11). That does not change the architecture.

## 8. Block and report

- Block uses `ignore_user`. Messages from that user are hidden on all of the user's devices. The blocked user is not notified by the app.
- Report sends a Matrix content report to the homeserver admin, containing only the event the user chose to report and an optional reason. The app explains before sending that the reported message content will be visible to the admin.

## 9. Interface

- White background `#ffffff`; text `#111820`; secondary text `#52606b`; dividers `#d6dce1` (1px); accent and focus `#2454dd`.
- System Helvetica/Arial stack, weight 400 headings, tight heading letter spacing, square corners.
- Product name shown as plain text "FabriC++". No Infinitum logo.
- Screens: Sign in, Chat list, Conversation, New chat (enter user id), Contact details (verification state, verify, block, report), Settings (devices, sign out), Plan (entitlement, upgrade when available), Data revenue (consent on/off, earnings ledger).
- Message status: sending, sent, failed (tap to retry), unable to decrypt.
- Source of tokens: https://infinitum-corporation.vercel.app/assets/one-page.css

## 10. Monetization (according to repo notes)

### 10.1 Source of truth

Repo notes in `InfinitumCorp/infinitum-revenue` at commit `c8c4cb9`:

- `MONETIZATION.md`: FABRIC is "Free personal (growth); Business $8/seat with compliance features; opt-in data revenue share (30% platform)". Earnings are kept in a USD ledger and paid by bank (Stripe Connect). Token payouts are behind `TOKEN_PAYOUTS_ENABLED=false` until counsel signs off. Every listing needs an active, purpose-specific consent; withdrawing consent delists immediately; individual accounts cannot buy data.
- `src/catalog.ts`:
  - `fabric_personal`: price 0, monthly, civil accounts.
  - `fabric_business`: 800 cents per seat per month, organizations only, includes 500 `fabric_business_minutes`, features `admin_console`, `retention_policies`, `compliance_export`.
  - Data share: `{ product: "fabric", contributorShareBps: 7000, missionFeeBps: 0, holdDays: 14 }` ("70% to users, as published").

This spec uses those values: 70% contributor share, 14-day hold, Personal free, Business $8 per seat per month, USD ledger, tokens off. No other prices or token economics are introduced.

### 10.2 Known conflicts (blockers for implementation, not changed by this spec)

1. Share mismatch: `infinitum-nexus/packages/data-exchange` defaults to 85% to the user (`revshare.ts`, `types.ts` `revSharePct // default 85`). The revenue repo and the public product page say 70%. Implementation must make FABRIC use the revenue repo value and must not ship with two numbers.
2. Automatic consent: `DataExchange.packageDataset` (`packages/data-exchange/src/index.ts`) creates a consent grant when it packages a dataset, and `FabricCollector` lists at a fixed price. That does not meet the explicit, prior, purpose-specific consent rule. Implementation must require an existing active consent and refuse otherwise.
3. Public page promises not backed by code: $FAB payouts to FIRM Wallet (tokens off per notes), burner numbers (no implementation), voice/bridge minutes (no FABRIC calling). These are not offered or sold in this release.

### 10.3 Plans and entitlements

- The app reads entitlements from the revenue API (`entitlements`, `subscriptions/checkout`, `billing/portal` endpoints described in the revenue README). The app never holds Stripe keys.
- Personal: all release-1 features, free.
- Business: per-seat plan for organizations. Release 1 implements entitlement checks and the upgrade path against the revenue API with its fake payment provider. Business-only features (admin console, retention policies, compliance export) are built as separate, later items; until each exists it is not listed as included in the app. Included minutes are not shown because FABRIC calling does not exist.
- Live checkout is disabled until a person approves Stripe configuration (keys, webhook, tax). The UI shows "Not available yet" rather than a working purchase.
- App store rules for in-app digital subscriptions are a decision for the owner (section 13); this spec does not assume web checkout is allowed inside the iOS or Android app.

### 10.4 Opt-in data revenue

- Off by default, on a separate "Data revenue" screen. Messaging works the same whether it is on or off.
- Turning it on shows the purpose, exactly what is counted, the 70% share, the 14-day hold and that payouts are in USD and not yet active. Consent is recorded per purpose with a timestamp and version of the terms.
- Turning it off revokes the consent immediately; the revenue API delists the user's assets and no new data is sent.
- What may be counted, on the device only: number of messages sent and received per day, session length. Never message content, contact or room identifiers, recipient ids, phone numbers or decrypted text. Nothing is read from the Matrix server for this.
- Counts are aggregated on the device and sent to the revenue API (consents, marketplace assets) only while consent is active. Aggregation across users and minimum group sizes are server responsibilities to be specified in the plan.
- ÆTHER MIL data never enters this flow, and FABRIC does not depend on ÆTHER code for monetization.

### 10.5 Earnings ledger

- The app shows only real ledger entries from the revenue API: sale, eligible revenue, the user's 70% amount in USD, hold release date, status. Zero sales show $0.00. No estimates, sample or projected balances.
- Payouts (Stripe Connect) and token conversion are disabled. The screen says so.

### 10.6 Backend split

- Synapse handles accounts, devices and encrypted relay only. It has no billing or data-revenue role.
- The revenue API (`infinitum-revenue`) handles plans, entitlements, consents, assets, sales and the ledger.
- The link between a Matrix account and a revenue account is a server-side mapping created at sign-up. Release 1 uses Matrix accounts; CID sign-in is a later step.

## 11. Dependencies outside the code

- FABRIC++ domain: `infinitumfabric.app`, hosted at Cloudflare. Local development stays on plain HTTP localhost. A device test outside the local network uses this domain.
- iOS: a Mac with Xcode is required for iOS builds. This Linux box cannot build or validate iOS.
  - Free Apple ID (personal team): can install a development build on your own device; profiles expire after 7 days; no TestFlight or App Store.
  - Paid Apple Developer Program: needed for TestFlight and App Store distribution.
- Android: Android SDK. Debug builds sideload without accounts. Play distribution needs a Play Console account and an upload key.
- Stripe account, keys, webhook and Connect: needed for live billing and payouts; not configured by this work.
- No account purchases, provisioning, public deployment or store submission are part of this spec.

## 12. Implementation gates

1. Version gate: pin one tested set of Expo SDK, React Native, matrix-rust-components-swift, sdk-android and Synapse. Record the versions and re-check the section 3 API table.
2. Licensing review (owner and counsel, not decided here):
   - Synapse is AGPL-3.0-or-later or an Element commercial licence. Running modified Synapse as a network service has source-offer obligations.
   - Matrix Rust SDK and the bindings are Apache-2.0 (notice and attribution obligations).
3. Monetization gate: resolve the 70% vs 85% conflict and the automatic-consent behaviour (section 10.2) in the code before any FABRIC data is packaged. Owner and counsel review data sale, rewards, tax and app store rules.
4. Bridge spike: login, encrypted store with key, send and receive one encrypted message on an Android emulator and an iOS simulator, before building the full UI.

## 13. Owner decisions still open

The FABRIC++ domain is `infinitumfabric.app`, hosted at Cloudflare. That decision is closed.

1. Hosting for the revenue API.
2. In-app purchase vs web checkout for Business on iOS and Android.
3. When to enable live Stripe charges and Connect payouts.
4. Counsel review of the data revenue programme and tokens before any payout.

## 14. Tests and acceptance

Automated and local (Linux box plus a Mac for iOS):

- Unit tests for the JS state layer with a mocked bridge
- Native bridge tests against the local Synapse compose
- Server check: event rows for the test room contain only `m.room.encrypted` content, and no test plaintext appears in the database or logs

Negative cases that must pass:

- Sending into an unencrypted room is refused
- Missing or wrong store key leads to a locked state, never plaintext fallback
- An undecryptable event shows no content
- A peer identity change blocks sending until acknowledged
- An expired or revoked token signs the user out cleanly
- Logout deletes the local store, cache and Keychain/Keystore entries
- Logs contain no message text or tokens (grep test on captured logs)
- Registration without a token fails; a federation request is refused
- Data revenue is off on a fresh install; no counts leave the device without an active consent
- Revoking consent stops sending immediately and the asset is delisted
- Counted data contains no message text, contact, room or recipient identifiers (inspect payloads)
- Business-only features are refused for a Personal entitlement
- With payments disabled, checkout and payout calls are refused and the UI says not available
- Earnings screen shows only ledger entries; an empty ledger shows $0.00

Two-device sign-off, separate from mocks and simulators. Requires one physical Android phone and one physical iPhone:

- Android to iPhone and iPhone to Android messages decrypt
- SAS emoji verification between the two phones
- Offline send: airplane mode, send, reconnect, delivered once
- App kill and relaunch keeps history and verification
- Reinstall on iOS does not reuse stale Keychain keys
- Block and report work end to end

## 15. Sources

- Matrix Rust SDK (Apache-2.0, FFI bindings): https://github.com/matrix-org/matrix-rust-sdk and `bindings/matrix-sdk-ffi`
- Swift package: https://github.com/matrix-org/matrix-rust-components-swift
- Synapse (AGPL-3.0-or-later / commercial): https://github.com/element-hq/synapse
- Expo development builds: https://docs.expo.dev/develop/development-builds/introduction
- Expo custom native code: https://docs.expo.dev/workflow/customizing/
- expo-secure-store: https://docs.expo.dev/versions/latest/sdk/securestore/
- Repo notes: https://github.com/InfinitumCorp/infinitum-revenue/blob/c8c4cb9b115ab384971af70cc62d5b8cd1e99c4d/MONETIZATION.md and src/catalog.ts at the same commit
- Data exchange code: https://github.com/InfinitumCorp/infinitum-nexus/tree/53280386bef8475e0e109111712184fb8459ab34/packages/data-exchange/src
- ÆTHER spec: https://github.com/InfinitumCorp/infinitum-nexus/blob/53280386bef8475e0e109111712184fb8459ab34/packages/aether/docs/SPEC.md
