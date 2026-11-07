#!/bin/bash
# Runs owner/peer gate tests with fresh throwaway users (server/make-gate-users.sh). Never prints passwords.
G="$(cd "$(dirname "$0")/../../server" && pwd)"
for t in "$@"; do
  (cd "$G" && sudo -n ./make-gate-users.sh >/dev/null && sudo -n chown "$(id -u)" .stage3/gate.env) || { echo "user setup failed"; exit 1; }
  set -a; . "$G/.stage3/gate.env"; set +a
  adb shell pm clear expo.modules.fabricmatrix.test >/dev/null; echo "## $t $(date +%T)"
  timeout 320 adb shell am instrument -w -e class expo.modules.fabricmatrix.$t -e hs http://10.0.2.2:8008 -e oUser "$G_OWNER" -e oPw "$G_OWNER_PW" -e pUser "$G_PEER" -e pPw "$G_PEER_PW" expo.modules.fabricmatrix.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | grep -vF -e "$G_OWNER_PW" -e "$G_PEER_PW" | grep -E 'OK|Fail|Exception|Error|Time:|at expo' | head -8; echo "rc=${PIPESTATUS[0]}"
done
