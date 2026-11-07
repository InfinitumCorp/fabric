#!/usr/bin/env bash
# Builds android/out/fabric.apk with the SDK's own tools (aapt2, javac, d8, apksigner), no Gradle.
# Signed with the local debug key: fine for testing on your own phone, not for a store.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
EXE=""; [ -f "$BT/aapt2.exe" ] && EXE=".exe"
rm -rf out && mkdir -p out/res out/classes out/dex out/gen

"$BT/aapt2$EXE" compile --dir res -o out/res/res.zip
# FABRIC_DEBUG=1 marks the APK debuggable, which also lets chrome://inspect attach to its WebView
DBG=""; [ "${FABRIC_DEBUG:-}" = "1" ] && DBG="--debug-mode"
"$BT/aapt2$EXE" link -o out/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml --java out/gen out/res/res.zip --auto-add-overlay $DBG
# FABRIC_RELAY=https://relay.example bash android/build.sh  bakes in another default relay
mkdir -p out/src && cp -r src/. out/src/
if [ -n "${FABRIC_RELAY:-}" ]; then
  case "$FABRIC_RELAY" in https://*/) ;; *) echo "FABRIC_RELAY must be https://…/ (ending in /)"; exit 1 ;; esac
  sed -i "s|DEFAULT_RELAY = \"http://localhost:8788/\"|DEFAULT_RELAY = \"$FABRIC_RELAY\"|" out/src/com/infinitum/fabric/MainActivity.java
fi
javac -source 11 -target 11 -nowarn -classpath "$JAR" -d out/classes $(find out/src out/gen -name '*.java')
"$BT/d8.bat" --min-api 26 --lib "$JAR" --output out/dex $(find out/classes -name '*.class') 2>/dev/null || \
  "$BT/d8" --min-api 26 --lib "$JAR" --output out/dex $(find out/classes -name '*.class')
(cd out/dex && zip -q -j ../unsigned.apk classes.dex 2>/dev/null || jar uf ../unsigned.apk classes.dex)
"$BT/zipalign$EXE" -f -p 4 out/unsigned.apk out/aligned.apk
KS="${FABRIC_KEYSTORE:-$HOME/.android/debug.keystore}"
"$BT/apksigner.bat" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out out/fabric.apk out/aligned.apk 2>/dev/null || \
  "$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out out/fabric.apk out/aligned.apk
"$BT/apksigner.bat" verify out/fabric.apk 2>/dev/null || true
echo "built android/out/fabric.apk"
