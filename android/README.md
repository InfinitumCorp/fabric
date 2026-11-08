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
- relay: `https://infinitumfabric.app` (editable on the sign-in screen, HTTPS only)
- test login: none. Continue calls `GET /api/health` with no account, password, or token. Registration is a signed WebSocket `register` and is not performed by this build.

Release builds enable R8. There is no upload key in this repository. The debug APK is signed with the Android debug keystore so a device can install it.
