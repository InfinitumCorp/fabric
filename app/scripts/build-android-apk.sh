#!/usr/bin/env bash
# Private test APK with bundled JS; no Metro server is needed on the phone.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV=production
npx expo prebuild --platform android --no-install
cd android
./gradlew assembleRelease \
  "-PreactNativeArchitectures=${FABRIC_ANDROID_ABIS:-arm64-v8a}" \
  -PfabricDiagnosticScreenshots=false \
  --max-workers=2 --no-daemon
