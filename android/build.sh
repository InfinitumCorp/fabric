#!/usr/bin/env bash
# Builds android/out/fabric.apk with the SDK's own tools (aapt2, javac, d8, apksigner), no Gradle.
# Signed with the local debug key: fine for testing on your own phone, not for a store.
#
# Release: FABRIC_RELEASE=1 bash android/build.sh  ->  android/out/fabric-release.apk
#   Locked to FABRIC_RELAY (default https://relay.infinitumfabric.app/): no relay launch extra, no plain
#   http at all, not debuggable. Signed with FABRIC_KEYSTORE (default ~/.android/fabric-release/
#   fabric-release.jks), whose password is in FABRIC_KS_PASS_FILE (default: storepass next to it).
#   Keep both out of the repo and backed up: every update must be signed with the same key.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
EXE=""; [ -f "$BT/aapt2.exe" ] && EXE=".exe"
rm -rf out && mkdir -p out/res out/classes out/dex out/gen

REL="${FABRIC_RELEASE:-}"
if [ "$REL" = "1" ]; then
  if [ "${FABRIC_DEBUG:-}" = "1" ]; then echo "a release build can't be debuggable"; exit 1; fi
  FABRIC_RELAY="${FABRIC_RELAY:-https://relay.infinitumfabric.app/}"
  KS="${FABRIC_KEYSTORE:-$HOME/.android/fabric-release/fabric-release.jks}"
  PASSFILE="${FABRIC_KS_PASS_FILE:-$(dirname "$KS")/storepass}"
  [ -f "$KS" ] || { echo "release keystore not found: $KS"; exit 1; }
  [ -f "$PASSFILE" ] || { echo "keystore password file not found: $PASSFILE"; exit 1; }
  # apksigner is Java: on Windows it needs C:\ paths, not Git Bash /c/ ones
  if command -v cygpath >/dev/null; then KS="$(cygpath -w "$KS")"; PASSFILE="$(cygpath -w "$PASSFILE")"; fi
  KSPASS="file:$PASSFILE"
  OUT=out/fabric-release.apk
else
  KS="${FABRIC_KEYSTORE:-$HOME/.android/debug.keystore}"
  KSPASS="pass:android"
  OUT=out/fabric.apk
fi

# resources; a release drops the plain-http exception for localhost
mkdir -p out/res-src && cp -r res/. out/res-src/
if [ "$REL" = "1" ]; then
  cat > out/res-src/xml/network_security.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<!-- Release build: https only. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
XML
fi
"$BT/aapt2$EXE" compile --dir out/res-src -o out/res/res.zip
# FABRIC_DEBUG=1 marks the APK debuggable, which also lets chrome://inspect attach to its WebView
DBG=""; [ "${FABRIC_DEBUG:-}" = "1" ] && DBG="--debug-mode"
"$BT/aapt2$EXE" link -o out/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml --java out/gen out/res/res.zip --auto-add-overlay $DBG
# FABRIC_RELAY=https://relay.example bash android/build.sh  bakes in another default relay
mkdir -p out/src && cp -r src/. out/src/
if [ -n "${FABRIC_RELAY:-}" ]; then
  case "$FABRIC_RELAY" in https://*/) ;; *) echo "FABRIC_RELAY must be https://…/ (ending in /)"; exit 1 ;; esac
  sed -i "s|DEFAULT_RELAY = \"http://localhost:8788/\"|DEFAULT_RELAY = \"$FABRIC_RELAY\"|" out/src/com/infinitum/fabric/MainActivity.java
fi
if [ "$REL" = "1" ]; then
  sed -i "s|boolean RELEASE = false;|boolean RELEASE = true;|" out/src/com/infinitum/fabric/MainActivity.java
  grep -q "boolean RELEASE = true;" out/src/com/infinitum/fabric/MainActivity.java || { echo "couldn't lock the release build"; exit 1; }
fi
javac -source 11 -target 11 -nowarn -classpath "$JAR" -d out/classes $(find out/src out/gen -name '*.java')
"$BT/d8.bat" --min-api 26 --lib "$JAR" --output out/dex $(find out/classes -name '*.class') 2>/dev/null || \
  "$BT/d8" --min-api 26 --lib "$JAR" --output out/dex $(find out/classes -name '*.class')
(cd out/dex && zip -q -j ../unsigned.apk classes.dex 2>/dev/null || jar uf ../unsigned.apk classes.dex)
"$BT/zipalign$EXE" -f -p 4 out/unsigned.apk out/aligned.apk
"$BT/apksigner.bat" sign --ks "$KS" --ks-pass "$KSPASS" --out "$OUT" out/aligned.apk 2>/dev/null || \
  "$BT/apksigner" sign --ks "$KS" --ks-pass "$KSPASS" --out "$OUT" out/aligned.apk
"$BT/apksigner.bat" verify "$OUT" 2>/dev/null || "$BT/apksigner" verify "$OUT"
echo "built android/$OUT"
