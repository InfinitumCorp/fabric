#!/bin/bash
# Runs gate test classes (or Class#method). Each test method gets its own fresh owner/peer accounts from a
# pool created here (server/make-gate-users.sh). Never prints passwords. Usage: run-gate-tests.sh Class[#m] ...
G="$(cd "$(dirname "$0")/../../server" && pwd)"
for t in "$@"; do
  (cd "$G" && sudo -n ./make-gate-users.sh 4 >/dev/null && sudo -n chown "$(id -u)" .stage3/gate.env) || { echo "user setup failed"; exit 1; }
  set -a; . "$G/.stage3/gate.env"; set +a
  extra=(); secrets=()
  for u in ${G_POOL//,/ }; do v="G_PW_$u"; extra+=(-e "pw.$u" "${!v}"); secrets+=(-e "${!v}"); done
  adb shell pm clear expo.modules.fabricmatrix.test >/dev/null; echo "## $t $(date +%T)"
  timeout 600 adb shell am instrument -w -e class expo.modules.fabricmatrix.$t -e hs http://10.0.2.2:8008 -e pool "$G_POOL" "${extra[@]}" expo.modules.fabricmatrix.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | grep -vF "${secrets[@]}" | grep -E 'OK|Fail|Exception|Error|Time:|at expo|Tests run' | head -10; echo "rc=${PIPESTATUS[0]}"
done
