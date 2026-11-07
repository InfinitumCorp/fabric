#!/usr/bin/env bash
# Disposable local Synapse for the browser prototype tests.
# Binds 127.0.0.1:18408 only. Does not read or write server/data, and does not use port 8008.
# Passwords are written to web/.local/fixture.env and are not printed.
set -euo pipefail
cd "$(dirname "$0")/.."
LOCAL=".local/synapse"
PORT=18408
IMG=matrixdotorg/synapse:v1.164.2

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not available; the local Synapse fixture was not started" >&2
  exit 2
fi
if command -v ss >/dev/null 2>&1 && ss -ltn | awk '{print $4}' | grep -Eq "(^|:)(${PORT})$"; then
  if [[ -f .local/fixture.env ]]; then
    echo "fixture already listening on 127.0.0.1:${PORT}"
    exit 0
  fi
  echo "refusing: 127.0.0.1:${PORT} is in use and this fixture did not create it" >&2
  exit 3
fi

mkdir -p "$LOCAL/data"
if [[ ! -f "$LOCAL/.env" ]]; then
  umask 077
  printf 'FABRIC_DB_PASSWORD=%s\n' "$(openssl rand -hex 16)" > "$LOCAL/.env"
fi
if [[ ! -f "$LOCAL/data/homeserver.yaml" ]]; then
  docker run --rm -v "$PWD/$LOCAL/data:/data" -e SYNAPSE_SERVER_NAME=fabric.localhost -e SYNAPSE_REPORT_STATS=no "$IMG" generate >/dev/null
fi
# shellcheck disable=SC1091
. "$LOCAL/.env"
docker run --rm -i -v "$PWD/$LOCAL/data:/data" -e DBPW="$FABRIC_DB_PASSWORD" --entrypoint python "$IMG" - <<'PY'
import os, yaml
p = "/data/homeserver.yaml"
c = yaml.safe_load(open(p))
c["database"] = {"name": "psycopg2", "args": {"user": "synapse", "password": os.environ["DBPW"], "database": "synapse", "host": "127.0.0.1", "cp_min": 2, "cp_max": 5}}
c["listeners"] = [{"port": 8008, "type": "http", "tls": False, "x_forwarded": False, "bind_addresses": ["0.0.0.0"], "resources": [{"names": ["client"], "compress": False}]}]
c["enable_registration"] = False
c["federation_domain_whitelist"] = []
c["allow_public_rooms_over_federation"] = False
c["trusted_key_servers"] = []
c["encryption_enabled_by_default_for_room_type"] = "all"
c["report_stats"] = False
relaxed = {"per_second": 50, "burst_count": 100}
c["rc_login"] = {"address": relaxed, "account": relaxed, "failed_attempts": relaxed}
yaml.safe_dump(c, open(p, "w"), sort_keys=False)
PY

cat > "$LOCAL/docker-compose.yml" <<'YAML'
name: fabric-browser-fixture
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: synapse
      POSTGRES_PASSWORD: ${FABRIC_DB_PASSWORD:?}
      POSTGRES_DB: synapse
      POSTGRES_INITDB_ARGS: "--encoding=UTF-8 --lc-collate=C --lc-ctype=C"
    volumes: ["./pgdata:/var/lib/postgresql/data"]
    ports: ["127.0.0.1:18408:8008"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U synapse -h 127.0.0.1"]
      interval: 2s
      retries: 40
  synapse:
    image: matrixdotorg/synapse:v1.164.2
    network_mode: "service:db"
    depends_on:
      db: { condition: service_healthy }
    volumes: ["./data:/data"]
YAML

docker compose --project-directory "$LOCAL" --env-file "$LOCAL/.env" up -d
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/_matrix/client/versions" >/dev/null; then
    break
  fi
  sleep 2
done
curl -sf "http://127.0.0.1:${PORT}/_matrix/client/versions" >/dev/null

if [[ ! -f .local/fixture.env ]]; then
  umask 077
  alice="wb$(openssl rand -hex 3)"
  bob="wb$(openssl rand -hex 3)"
  alice_pw="$(openssl rand -hex 16)"
  bob_pw="$(openssl rand -hex 16)"
  create() {
    docker compose --project-directory "$LOCAL" exec -T synapse register_new_matrix_user \
      -c /data/homeserver.yaml -u "$1" -p "$2" --no-admin "http://127.0.0.1:8008" >/dev/null
  }
  create "$alice" "$alice_pw"
  create "$bob" "$bob_pw"
  printf 'HOMESERVER=http://127.0.0.1:%s\nALICE=%s\nALICE_PW=%s\nBOB=%s\nBOB_PW=%s\n' \
    "$PORT" "$alice" "$alice_pw" "$bob" "$bob_pw" > .local/fixture.env
  echo "created fresh fixture users @${alice}:fabric.localhost and @${bob}:fabric.localhost"
fi
echo "fixture ready at http://127.0.0.1:${PORT} (credentials stay in web/.local/fixture.env)"
