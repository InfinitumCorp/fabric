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

## Not in this stage (next gates)
- **SAS device verification.** `deviceVerification` is false and the UI says so. Peers show "Not verified".
- **Identity-change acknowledgement.** It has not been exercised end to end, because that needs a verified peer, which needs SAS first.
- **Offline catch-up proof**: kill the app, have the peer send, relaunch, see the message.
- Block/report, `FLAG_SECURE`, contact details screen.
- **Live plan and earnings.** `infinitum-revenue` has no per-user mobile token yet, so these stay "Not connected". Payments stay disabled.
- Real-device and two-phone sign-off; iOS.

## Password handling tradeoff
The password is typed into a React Native `TextInput` and crosses the JS bridge once, inside `login(...)`. It is kept in a ref, not in React state, and cleared after the attempt. It is never logged or stored. Access tokens and store keys never reach JS. A fully native sign-in view would keep the password out of JS entirely; that is a possible hardening step later.

## Verification
- `core`: `npm test` and `npm run typecheck`.
- Native tests: `app/scripts/run-native-tests.sh MatrixEngineTest MessengerTest`, which needs the local Synapse.
- UI: emulator, with `PeerEchoTest` as the second real SDK client, then a server DB check that the events are `m.room.encrypted` with 0 plaintext hits.
