# Local Synapse (development only)

Stage 2 of the FabriC++ plan (infinitum-nexus PR #23). Synapse `v1.164.2` (unmodified `matrixdotorg/synapse` image) and PostgreSQL 16, for local testing. Not for deployment.

## Run

```bash
./configure.sh                       # generates ./data/homeserver.yaml and ./.env (random DB password); both git-ignored
docker compose --env-file .env up -d
./check-policy.sh                    # configuration checks
./smoke.sh                           # real-server smoke test, creates @alice / @bob with random passwords in ./data/test-users.env
docker compose --env-file .env down  # stop; `rm -rf data pgdata .env` to start fresh
```

## Policy set by `configure.sh`

- `enable_registration: false` (accounts only via `register_new_matrix_user` with the generated shared secret)
- Listener serves only the `client` resource; `federation_domain_whitelist: []`; `trusted_key_servers: []`
- `encryption_enabled_by_default_for_room_type: all`
- PostgreSQL; only `127.0.0.1:8008` is published. Postgres is not published.
- Synapse shares the database container's network namespace and reaches Postgres at `127.0.0.1`. This avoids Docker's embedded DNS, which needs iptables; the dev box runs `dockerd --iptables=false`.

## What this proves, and what it does not

| Check | Result on 2026-11-07 |
|---|---|
| Registration closed | 403 |
| Federation and server-key APIs | 404 |
| Ports | only 127.0.0.1:8008 |
| Login / wrong password | ok / refused |
| New direct chat has `m.room.encryption` | `m.megolm.v1.aes-sha2` |
| Plaintext from a raw client | **Accepted by Synapse** and stored |
| `check-no-plaintext.sh` on that canary | Detected (exit 1) |

Synapse does not enforce end-to-end encryption. A room's encryption setting does not stop a client from sending plaintext. In FabriC++ the guarantee comes from the client: the app refuses to send unless the room is encrypted (`core/src/rules.ts`) and only the Matrix Rust SDK produces message events. `check-no-plaintext.sh` detects plaintext after the fact; it is not proof of encryption.

Not yet shown: a real encrypted round trip. That needs two SDK clients (Stage 3/5). The positive check is: send a known marker through the app, then `./check-no-plaintext.sh MARKER` exits 0 and the count of `m.room.encrypted` events rises. No hand-made ciphertext is used as evidence.

Open decision: server-side rejection of unencrypted message events would need a Synapse module (`check_event_allowed` callback). That adds code loaded into an AGPL-licensed server and needs a licensing review first.
