#!/bin/bash
# Builds the DIAGNOSTIC x86_64 app (compile-time screenshot flag, non-minified so it can be instrumented) plus the
# test-only VisualFixture APK. Fixture source lives in app/fixtures/visual and is copied into the generated (gitignored)
# android/ project only for this build. Never used for distributable builds.
set -euo pipefail
A="$(cd "$(dirname "$0")/.." && pwd)/android"
D="$A/app/src/androidTest/java/com/infinitum/fabric/fixture"; mkdir -p "$D"; cp "$A/../fixtures/visual/VisualFixture.kt" "$D/"
if ! grep -q 'FABRIC_VISUAL_FIXTURE' "$A/app/build.gradle"; then cat >> "$A/app/build.gradle" <<'G'
// FABRIC_VISUAL_FIXTURE (test-only; added by scripts/build-visual-fixture.sh)
android { testBuildType "release"; defaultConfig { testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner" } }
dependencies { androidTestImplementation "androidx.test:runner:1.6.2"; androidTestImplementation "androidx.test.ext:junit:1.2.1"; androidTestImplementation "org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0" }
G
fi
cd "$A"; NODE_ENV=production ./gradlew -q assembleRelease assembleReleaseAndroidTest -PreactNativeArchitectures=x86_64 \
  -PfabricDiagnosticScreenshots=true -Pandroid.enableMinifyInReleaseBuilds=false \
  -Dorg.gradle.jvmargs="-Xmx3g" --max-workers=1 --no-daemon
ls -l app/build/outputs/apk/release/*.apk app/build/outputs/apk/androidTest/release/*.apk
