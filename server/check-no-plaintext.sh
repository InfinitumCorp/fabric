#!/usr/bin/env bash
# Searches stored event JSON for a marker string. Exit 1 if found.
# Detects plaintext after the fact; it does not prevent it and does not prove encryption by itself.
set -euo pipefail
cd "$(dirname "$0")"
M="${1:?usage: check-no-plaintext.sh MARKER}"
[[ "$M" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "marker must be [A-Za-z0-9_-]"; exit 2; }
q() { docker compose exec -T db psql -U synapse -d synapse -tAc "$1"; }
hits=$(q "select count(*) from event_json where json like '%$M%'")
enc=$(q "select count(*) from events where type = 'm.room.encrypted'")
echo "plaintext hits: $hits; m.room.encrypted events stored: $enc"
[ "$hits" = 0 ]
