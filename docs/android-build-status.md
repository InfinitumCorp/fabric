# Android build check — 2026-11-07

Source: `cursor/android-unblock-timeline-5ab2`, checked out for continued work on
`codex/android-build`. Company rules and Nexus mobile design source were pulled
from `InfinitumCorp/RULES` and `InfinitumCorp/infinitum-nexus`.

## Verified here

- Core: 17 tests pass and TypeScript typecheck passes.
- App: TypeScript typecheck and six bridge/security contract tests pass.
- Added the missing Expo ESLint configuration; `npm run lint` passes. The Expo
  lint wrapper rejects the installed ESLint 9 despite requesting it itself, so
  the script invokes ESLint directly with the Expo configuration.
- Expo Android prebuild succeeds with SDK 58 dependencies from the lockfile.
- Fixed restoration after signing in to a custom homeserver: native restoration
  now builds the client using the server in the encrypted session. The native
  restart test supplies an unrelated UI default to exercise this case.

The native regression still needs execution against Synapse on an Android device
or emulator; the TypeScript checks do not validate Kotlin or Matrix integration.

## Remaining blockers

- React Native 0.88.1 defaults to compile SDK 37 and build tools 37.0.0.
  Google's SDK catalog queried here did not provide `platforms;android-37`;
  sdkmanager reports that package missing. No framework downgrade or SDK override
  has been applied.
- The app's default server `http://10.0.2.2:8008` is emulator-only. The checked-in
  Synapse compose setup is explicitly development-only. Nexus identifies
  `infinitumfabric.app` as the product domain but does not establish a deployed
  Matrix service. Probes for Matrix discovery and client versions at that domain
  and client versions at `matrix.infinitumfabric.app` received proxy CONNECT 403;
  this does not prove the remote services are down.
- No phone is connected to this workspace. No phone installation or two-device
  verification has been performed.
- Plan/earnings integration and recovery-key restore remain unimplemented on
  this Android branch. See `stage5-android-plan.md` for the existing release gates.

No production deployment, DNS change, live charge or payout was performed.

## Repeat the checks

```sh
cd core
npm ci
npm test
npm run typecheck
cd ../app
npm ci
npx tsc --noEmit
node scripts/contract.test.mjs
npm run lint
npx expo prebuild --platform android --no-install
# Requires the SDK versions selected by the installed React Native release:
cd android
NODE_ENV=production ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

The generated release build uses the template debug signing key. It is for
private testing; store distribution needs separate release signing.
