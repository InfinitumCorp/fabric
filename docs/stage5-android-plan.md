# Stage 5 (Android): first working screens

This follows the approved spec (Nexus PR 23, `2026-11-07-fabric-mobile-design.md`, sections 3, 5, 6, 9, 10). It covers Android only. iOS waits for its own native gate.

## Scope
1. Native bridge (`Messenger.kt`), using SDK APIs only:
   - `syncService`
   - `rooms`
   - `createRoom` (encrypted, `TRUSTED_PRIVATE_CHAT`)
   - `join`
   - `Timeline` + listener
   - `Timeline.send`
   - `Encryption.userIdentity`
   - `UserIdentity.withdrawVerification`
2. Fail-closed sending, enforced natively and mirrored in `core/src/conversation.ts`. Sending is refused when:
   - the room is not encrypted, or its encryption state is unknown;
   - the peer is not resolved;
   - the peer's identity is unknown;
   - a verified identity has changed and the user has not acknowledged it.
3. Screens:
   - Sign in
   - Chat list (invites can be accepted)
   - New chat (by user id)
   - Conversation (trust label, "Unable to decrypt", sending/failed states)
   - Settings (account, Plan and Data revenue shown as "Not connected", sign out and erase)
4. A JS-bundled release-variant APK, signed with the debug key, per ABI.

## Added in this update (2026-11-07, about 06:00 MSK)
- **Native sign-in (`SignInActivity`, FLAG_SECURE).**
  - User name and password are entered and used in Kotlin. JS calls `signIn(hs)` and receives `{userId, deviceId}` or null.
  - The JS `login(...password)` route has been removed. `scripts/contract.test.mjs` fails if a password, token or key parameter, or a non-allow-listed return field, is added back.
- **SAS emoji verification** through the SDK's `SessionVerificationController`, with request, incoming, accept, emoji, match, mismatch and cancel. The UI is on the Contact screen. "Verified" comes only from the SDK's `didFinish` and `UserIdentity.isVerified`.
- **Identity change:** a verified peer's identity reset makes `send` refuse with `identity_changed`. Acknowledging calls `withdrawVerification`, and sending works again. Covered by `VerificationTest`.
- **Offline catch-up across process death:** `OfflineCatchUpTest` runs `setup`, `peerSend` and `catchUp` as three separate `am instrument` processes.
- **Blocking and reporting:**
  - Block uses the Matrix ignore list.
  - Report is long-press, opt-in per message. The dialog states exactly what is sent: event id, room id, user id and the reason "Abuse". The app never sends the message text.
- **FLAG_SECURE** on the main activity and the sign-in activity.

## Not in this stage (next gates)
- **New sign-in on an account that already has a cryptographic identity.** This device is then not cross-signed, so verifying others is refused (`own_device_unverified`). Self-verification or a recovery key is needed and is not built.
- **SAS is slow on the emulator** (about 60 s from accept to emoji). Tests allow 120 s.
- **Live plan and earnings.** `infinitum-revenue` has no per-user mobile token yet, so these stay "Not connected". Payments stay disabled.
- Real-device and two-phone sign-off; iOS.

## Password handling (superseded)
~~The password is typed into a React Native `TextInput` and crosses the JS bridge once, inside `login(...)`. It is kept in a ref, not in React state, and cleared after the attempt. It is never logged or stored. Access tokens and store keys never reach JS. A fully native sign-in view would keep the password out of JS entirely; that is a possible hardening step later.~~ Replaced by native sign-in, above.

## Verification
- `core`: `npm test` and `npm run typecheck`.
- Native tests: `app/scripts/run-native-tests.sh MatrixEngineTest MessengerTest`, which needs the local Synapse.
- UI: emulator, with `PeerEchoTest` as the second real SDK client, then a server DB check that the events are `m.room.encrypted` with 0 plaintext hits.
