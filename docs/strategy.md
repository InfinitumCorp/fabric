# FabriC++ strategy: where things stand (2026-11-09)

## Two builds of FabriC++ exist, and they have diverged

The `InfinitumCorp/fabric` repository holds two independent builds that share only the first commit
(`b048093`, "Initial README"). Neither contains the other.

| | Relay track (`feat/relay-pq`, this branch) | Matrix track (`main`) |
|---|---|---|
| Server | Our own Node relay (`server/relay.js`), SQLite with a sealed Supabase snapshot | Unmodified Synapse v1.164.2 + Postgres 16 (Docker compose; not run yet) |
| Encryption | Our own protocol: post-quantum hybrid sessions, sealed sender, signed device lists (`shared/crypto.js`) | Matrix Olm/Megolm through matrix-rust-sdk; spec forbids custom crypto on the secure path |
| Client | Browser app (`public/`) + Android WebView shell (`android/`) | Expo / React Native app (`app/`); native bridge not built yet |
| Running today | Yes: prod relay with tunnel, test phone, 148 tests | Core TypeScript logic and tests; no chat screens, no server running |
| Features | Chats, groups, calls + SFU, phone numbers (Twilio), number linking, Cumulus://ID sign-in, on-device AI, Earn | Fail-closed send rules, message status, log redaction, revenue client (payments disabled) |
| Also on `main` | | Public landing page (#12) |

Other branches: `feat/full-buildout` (Expo app + revenue client, the source of `main`'s #8) and
`feat/android-screens` (native Android gate for the Matrix SDK, Synapse server, FIRM Suite block, and a
"localhost session-only" browser client, #7 / #9).

### Why it matters

- The Matrix spec rules out custom cryptography; the relay track *is* custom cryptography. They can't both be the
  long-term answer for message security.
- Features built on one track (phone, number linking, SFU calls, Cumulus://ID) don't exist on the other.
- `main` is what most people will clone. Today it doesn't have the working app.

### Options (owner's decision)

1. **Relay track is the product.** Merge `feat/relay-pq` into `main` (keeping `landing/`), retire the Matrix
   plan or keep it as research. Fastest path to something people use; costs an outside crypto review before
   launch.
2. **Matrix track is the product.** Port features onto Synapse + Expo (phone, linking and calls become Matrix
   application services or bridges). Leans on audited crypto; months before parity with what runs now.
3. **Both, split by role.** Relay track for the browser/Android app now; Matrix for federation or enterprise
   later. Highest cost: two security models to maintain.

Recommendation: **option 1**, with an external review of `shared/crypto.js` before public launch, and take the
good parts of `main` across (fail-closed send rules, log redaction, landing page). Nothing is merged until you
choose.

## Relay track status

| Area | State |
|---|---|
| Interface | White default theme; mobile footer is only **+**, which opens all navigation (chats, calls, phone, settings) |
| Handles | Shown as `+name.veil`; stored as `@name.veil` because signed device lists depend on it. `+` or `@` both accepted when typed |
| Burner numbers | Paused (`FABRIC_BURNERS=1` to turn back on); no burner screens in the app |
| Number linking, Phase 1 | Built and tested: verify by text code, keyed-hash storage, opt-in discovery, encrypted call/chat instead of the phone network ([number-linking.md](number-linking.md)) |
| Number linking, Phase 2 | In progress: `shared/sealbox.js` (seal to every device of an account) written, not wired in |
| Number linking, Phase 3 | Not started: on-FabriC++ badges in phone history, opt-in contact matching |
| Prod go-live of linking | Waiting on owner: a Twilio Verify service SID and `FABRIC_NUMBER_PEPPER` on the prod relay, then a restart |
| Android icon | Arial "F" adaptive icon (from the MasterBuild session) |

## Next, in order

1. Owner decides the track question above.
2. Finish Phase 2: phone events and voicemail sealed to devices; the relay keeps only time, kind and call IDs.
3. Phase 3: badges and opt-in contact matching on Android.
4. Turn on linking in prod once Twilio Verify and the pepper are set.
5. Roadmap in the README (Cumulus://ID, multi-region SFU, relay scale, $FAB) after that.
