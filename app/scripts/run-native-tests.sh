#!/bin/bash
# Runs MatrixEngineTest one test at a time against local Synapse with a clean app state and a finite host timeout. Never prints passwords.
set -a; . $(cd "$(dirname "$0")/../../server" && pwd)/.stage3/users.env; set +a
for t in "$@"; do adb shell pm clear expo.modules.fabricmatrix.test >/dev/null; echo "## $t $(date +%T)"
timeout 230 adb shell am instrument -w -e class expo.modules.fabricmatrix.$t -e hs http://10.0.2.2:8008 -e aUser "$S3A" -e aPw "$S3A_PW" -e bUser "$S3B" -e bPw "$S3B_PW" -e marker "$MARKER" expo.modules.fabricmatrix.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | grep -vF -e "$S3A_PW" -e "$S3B_PW" | grep -E 'OK|Fail|Exception|Error|Time:|at expo' | head -8; echo "rc=${PIPESTATUS[0]}"; done
