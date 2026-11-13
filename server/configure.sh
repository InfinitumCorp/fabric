#!/usr/bin/env bash
# Generates a local Synapse config with release-1 policy. Secrets stay in ./data and ./.env (both git-ignored).
set -euo pipefail
cd "$(dirname "$0")"
IMG=matrixdotorg/synapse:v1.164.2
[ -f .env ] || echo "FABRIC_DB_PASSWORD=$(openssl rand -hex 16)" > .env
mkdir -p data
if [ ! -f data/homeserver.yaml ]; then
  docker run --rm -v "$PWD/data:/data" -e SYNAPSE_SERVER_NAME=fabric.localhost -e SYNAPSE_REPORT_STATS=no "$IMG" generate >/dev/null
fi
# shellcheck disable=SC1091
. ./.env
docker run --rm -i -v "$PWD/data:/data" -e DBPW="$FABRIC_DB_PASSWORD" -e LOCAL_TEST_RATELIMITS="${FABRIC_LOCAL_TEST_RATELIMITS:-0}" --entrypoint python "$IMG" - <<'PY'
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
# Emulator test runs log in repeatedly from one address; Synapse defaults (failed-login lockout ~5 min) stall them.
# Opt-in only for the local test server; never set for a deployed server.
if os.environ.get("LOCAL_TEST_RATELIMITS") == "1":
    r = {"per_second": 50, "burst_count": 100}
    c["rc_login"] = {"address": r, "account": r, "failed_attempts": r}
else:
    c.pop("rc_login", None)
yaml.safe_dump(c, open(p, "w"), sort_keys=False)
PY
echo configured
