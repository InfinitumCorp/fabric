# Android build check — 2026-11-07

Source branch: `codex/android-build`, based on
`cursor/android-unblock-timeline-5ab2`. Company rules and Nexus mobile design
source were pulled from `InfinitumCorp/RULES` and `InfinitumCorp/infinitum-nexus`.

## Build configuration

- Expo 58 and React Native 0.88.1 remain pinned by the existing lockfile.
- Compile SDK 36, target SDK 36, minimum SDK 28, build tools 37.0.0,
  NDK 27.1.12297006, CMake 3.22.1.
- Five Expo modules (`expo-asset`, `expo-file-system`, `expo-font`,
  `expo-keep-awake`, `expo-status-bar`) build from their installed source through
  Expo autolinking. Their prebuilt AARs require API 37, which was not available
  from Google's SDK catalog queried here. AAR checks remain enabled.
- `plugins/withAndroidAbiFilters.js` aligns APK library packaging with the
  `reactNativeArchitectures` selection. This also excludes legacy JNA ABIs.
  Restricting only CMake still copied all third-party ABI libraries and exhausted
  this workspace's disk during the first packaging attempt.
- `npm run android:apk` creates a bundled-JS, non-diagnostic ARM64 test APK.
  `FABRIC_ANDROID_ABIS` can select other architectures when rebuilding.

## Checks

- Release APK build succeeds: 795 Gradle tasks, 6m 37s on this workspace.
- APK signature verifies (v2); package `com.infinitum.fabric`, version 1.0.0,
  Android 9+ (minimum API 28), target API 36. Only ARM64 libraries are packaged,
  and the JavaScript bundle is included.
- APK size: 92,532,642 bytes. SHA-256:
  `6e1d309775879ca5c1e11c0a05ff9b132807367f3d2eedc98888eb59244426c0`.
- Core: 17 tests and TypeScript typecheck pass.
- App: lint, TypeScript typecheck and six bridge/security contract tests pass.
- Expo Android prebuild succeeds.
- Native restoration uses the server stored in the encrypted session rather
  than the UI's emulator default. The native restart test supplies an unrelated
  UI address to cover this regression. That instrumented test still needs a
  running Synapse and Android device/emulator; static checks do not validate it.

## Rebuild

Install JDK 17 (used by native module toolchains), JDK 21 (Gradle), Android command
line tools and the packages above. Accept Android SDK licenses with sdkmanager.
Point `ANDROID_HOME` at the SDK. Then:

```sh
cd core
npm ci
npm test
npm run typecheck
cd ../app
npm ci
npm run lint
npx tsc --noEmit
node scripts/contract.test.mjs
npm run android:apk
```

Output: `app/android/app/build/outputs/apk/release/app-release.apk`.
The generated release variant uses the Expo template's debug signing key for
private testing. Store distribution needs separate release signing. The app
bundles its JavaScript and does not need Metro on the phone.

## Still required for live use

- The checked-in default server `http://10.0.2.2:8008` is emulator-only. The
  Synapse compose setup is explicitly development-only. Nexus names
  `infinitumfabric.app` as the product domain but does not establish a deployed
  Matrix service. Probes for Matrix discovery/client versions on that domain
  and client versions on `matrix.infinitumfabric.app` received proxy CONNECT 403.
  This does not prove the remote service is down. The server field remains
  editable at sign-in.
- Phone installation and two-device encrypted messaging verification.
- Plan/earnings integration and recovery-key restoration remain unimplemented
  on this Android branch. See `stage5-android-plan.md` for the existing gates.

No production deployment, DNS change, live charge or payout was performed.
