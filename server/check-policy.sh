#!/usr/bin/env bash
# Stage 2 configuration checks against a running local server. These do not test end-to-end encryption.
set -uo pipefail
cd "$(dirname "$0")"
H=${H:-http://127.0.0.1:8008}
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "$H/_matrix/client/versions")
[ "$code" = 200 ] || { echo "FAIL server not reachable ($code)"; exit 1; }
ok "server reachable"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$H/_matrix/client/v3/register" -H 'Content-Type: application/json' \
  -d '{"username":"intruder","password":"x-123456789","auth":{"type":"m.login.dummy"}}')
[ "$code" != 200 ] && ok "registration closed ($code)" || bad "open registration"
code=$(curl -s -o /dev/null -w '%{http_code}' "$H/_matrix/federation/v1/version")
[ "$code" != 200 ] && ok "federation API not served ($code)" || bad "federation API served"
code=$(curl -s -o /dev/null -w '%{http_code}' "$H/_matrix/key/v2/server")
[ "$code" != 200 ] && ok "server key API not served ($code)" || bad "server key API served"
b=$(docker compose ps -q | xargs docker inspect --format '{{.Name}} {{json .HostConfig.PortBindings}}')
expected=$(printf '%s\n' '/fabric-local-db-1 {"8008/tcp":[{"HostIp":"127.0.0.1","HostPort":"8008"}]}' '/fabric-local-synapse-1 {}')
[ "$(echo "$b" | sort)" = "$expected" ] && ok "only 127.0.0.1:8008 published; Postgres not published" || bad "unexpected port bindings: $b"
exit $fail
