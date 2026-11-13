#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .local/synapse/docker-compose.yml ]]; then
  echo "no local fixture compose file"
  exit 0
fi
docker compose --project-directory .local/synapse --env-file .local/synapse/.env down
echo "fixture stopped"
