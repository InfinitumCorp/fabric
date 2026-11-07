#!/usr/bin/env bash
# Creates a fresh pair of throwaway local users for one native gate run (owner + peer) and writes
# their names/passwords to .stage3/gate.env (git-ignored). Prints user ids only, never passwords.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .stage3
s=$(date +%s)
O=gown$s; P=gpeer$s; OP=$(openssl rand -hex 16); PP=$(openssl rand -hex 16)
for pair in "$O:$OP" "$P:$PP"; do
  docker compose exec -T synapse register_new_matrix_user -c /data/homeserver.yaml -u "${pair%%:*}" -p "${pair#*:}" --no-admin http://localhost:8008 >/dev/null
  echo "created @${pair%%:*}:fabric.localhost"
done
umask 077; printf 'G_OWNER=%s\nG_OWNER_PW=%s\nG_PEER=%s\nG_PEER_PW=%s\n' "$O" "$OP" "$P" "$PP" > .stage3/gate.env
