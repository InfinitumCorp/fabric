#!/usr/bin/env bash
# Creates local test users with random passwords written to ./data/test-users.env (git-ignored). Prints no passwords.
set -euo pipefail
cd "$(dirname "$0")"
f=data/test-users.env
[ -f "$f" ] || printf 'ALICE_PW=%s\nBOB_PW=%s\n' "$(openssl rand -hex 12)" "$(openssl rand -hex 12)" > "$f"
. "$f"
for u in alice bob; do
  pw=$([ $u = alice ] && echo "$ALICE_PW" || echo "$BOB_PW")
  docker compose exec -T synapse register_new_matrix_user -c /data/homeserver.yaml -u $u -p "$pw" --no-admin http://localhost:8008 >/dev/null 2>&1 \
    && echo "created @$u:fabric.localhost" || echo "@$u:fabric.localhost exists or failed"
done
