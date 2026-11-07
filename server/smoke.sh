#!/usr/bin/env bash
# Real-server smoke test. Shows what Stage 2 can and cannot prove:
#  1. test users can log in,
#  2. new rooms get m.room.encryption by default,
#  3. the server still ACCEPTS a plaintext m.room.message from a raw client (Synapse does not enforce E2EE),
#  4. check-no-plaintext.sh detects that canary (negative control).
# Encrypted round trips need real SDK clients (Stage 3/5); this script sends no fake ciphertext.
set -uo pipefail
cd "$(dirname "$0")"
H=http://127.0.0.1:8008
./make-users.sh
. data/test-users.env
login() { curl -s -X POST "$H/_matrix/client/v3/login" -H 'Content-Type: application/json' \
  -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$1\"},\"password\":\"$2\"}" | jq -r '.access_token // empty'; }
T=$(login alice "$ALICE_PW"); [ -n "$T" ] && echo "ok   alice logged in" || { echo "FAIL alice login"; exit 1; }
[ -z "$(login alice wrong-password)" ] && echo "ok   wrong password refused" || { echo "FAIL wrong password accepted"; exit 1; }
R=$(curl -s -X POST "$H/_matrix/client/v3/createRoom" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"preset":"trusted_private_chat","is_direct":true,"invite":["@bob:fabric.localhost"]}' | jq -r .room_id)
alg=$(curl -s "$H/_matrix/client/v3/rooms/$R/state/m.room.encryption/" -H "Authorization: Bearer $T" | jq -r '.algorithm // empty')
[ "$alg" = "m.megolm.v1.aes-sha2" ] && echo "ok   new DM has m.room.encryption ($alg)" || { echo "FAIL room not encrypted by default"; exit 1; }
CANARY="CANARY_$(openssl rand -hex 6)"
eid=$(curl -s -X PUT "$H/_matrix/client/v3/rooms/$R/send/m.room.message/smoke$RANDOM" -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d "{\"msgtype\":\"m.text\",\"body\":\"$CANARY\"}" | jq -r '.event_id // empty')
[ -n "$eid" ] && echo "note server accepted a plaintext event in an encrypted room (expected: Synapse does not enforce E2EE)" \
  || echo "note server rejected the plaintext event"
if ./check-no-plaintext.sh "$CANARY" >/tmp/fabric-np.txt; then echo "FAIL detector missed the canary"; exit 1
else echo "ok   detector found the plaintext canary ($(cat /tmp/fabric-np.txt))"; fi
curl -s -X POST "$H/_matrix/client/v3/logout" -H "Authorization: Bearer $T" >/dev/null
echo "smoke done"
