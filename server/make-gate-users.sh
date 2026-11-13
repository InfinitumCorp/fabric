#!/usr/bin/env bash
# Creates N fresh pairs of throwaway local users (owner + peer) for one gate run and writes them to
# .stage3/gate.env (git-ignored) as G_POOL="o1,p1,o2,p2,..." and G_PW_<user>=<password>. Prints ids only.
set -euo pipefail
cd "$(dirname "$0")"
n=${1:-1}; mkdir -p .stage3; s=$(date +%s%N | cut -c1-13)
umask 077; out=.stage3/gate.env; : > "$out"; pool=""
for i in $(seq 1 "$n"); do
  for role in gown gpeer; do
    u="${role}${s}x$i"; pw=$(openssl rand -hex 16)
    docker compose exec -T synapse register_new_matrix_user -c /data/homeserver.yaml -u "$u" -p "$pw" --no-admin http://localhost:8008 >/dev/null
    printf 'G_PW_%s=%s\n' "$u" "$pw" >> "$out"; pool="$pool${pool:+,}$u"
  done
done
printf 'G_POOL=%s\n' "$pool" >> "$out"
echo "created $n pair(s)"
