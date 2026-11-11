# FabriC++ Android

Native Kotlin and Jetpack Compose client. `minSdk` 26, `targetSdk` 35. The debug APK is universal and includes `lib/arm64-v8a` (plus armeabi-v7a, x86, and x86_64) for the Compose graphics library, so it installs on a TECNO phone running Android 15.

```bash
cd android
./gradlew lint test assembleDebug assembleDebugAndroidTest
```

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w app.infinitumfabric.client.test/androidx.test.runner.AndroidJUnitRunner
```

- applicationId: `app.infinitumfabric.client`
- launcher: `app.infinitumfabric.client.MainActivity`
- sign-in: **Sign in with Cumulus ID** / **Create a Cumulus ID**. A Custom Tab opens `https://id.cumuluscloud.app/api/id/authorize` (client `fabric`, PKCE S256; Create adds `prompt=create`). The IdP returns to `https://infinitumfabric.app/cid/return`, which this app claims as a verified App Link (`landing/public/.well-known/assetlinks.json`); if the browser keeps the page, it hands off to `infinitumfabric://cid/return`. The app redeems the code at `/api/id/token`. No password, PIN or passcode is stored.
- issuer: `-PcidIssuer=https://<mirror>` swaps in a Russia-reachable Cumulus ID mirror (HTTPS only).
- relay: `https://infinitumfabric.app`, editable under Advanced on the sign-in screen (HTTPS only). Registration is a signed WebSocket `register` and is not performed by this build.

Release builds enable R8. There is no upload key in this repository. Sign a release with the key kept outside it (password via file only):

```bash
./gradlew assembleRelease -PfabricKeystore=$HOME/.android/fabric-release/fabric-release.jks -PfabricStorePassFile=$HOME/.android/fabric-release/storepass
```
 The debug APK is signed with the Android debug keystore so a device can install it.
