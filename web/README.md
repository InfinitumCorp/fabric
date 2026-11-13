# FabriC++ browser prototype

Localhost-only, session-only web client. This is a limited prototype. It is not a production client, and it has not had a security audit.

Android and the local Synapse stack in `server/` are unchanged. This client reuses `core/` for send rules, redaction, and the consent gate.

## What this build does

- Sign in with a password to a **loopback** homeserver (`http://127.0.0.1`, `http://localhost`, or `http://[::1]`, any port).
- Encrypted direct chats: list, create, timeline, send, receive.
- Trust labels from the Matrix Rust crypto stack: Not verified, Verified, Identity changed, Identity unknown.
- Unverified known peers can send, with the label "Not verified".
- A verified identity change blocks sending until you acknowledge it.
- Emoji (SAS) verification for your own other device and for a contact. This app never resets an existing account identity. Recovery and key backup are not part of this build.
- Block and unblock through the server ignore list.
- Report one event. The report body is the score `-100` and the reason `Abuse`. The message text is not uploaded by the app.
- Sign out calls the server logout, stops the client, then clears the in-memory stores.
- Plan and data revenue stay **Not connected**. Message counts are not recorded, because this build cannot grant data-sharing consent.

## Session limits (accepted for this prototype)

- `matrix-js-sdk` 45.0.0 and `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0 are pinned. Crypto is the SDK's WASM, initialised with `useIndexedDB: false`. The sync store is `MemoryStore` with no `localStorage`.
- The password, access token, and encryption keys live in the page's JavaScript memory for this tab. They are not written to `localStorage`, `sessionStorage`, or IndexedDB by this app.
- Reloading the page creates a **new device**. Messages from before that visit may be undecryptable. History access is not guaranteed.
- Closing the tab does **not** reliably revoke the server session. There is no unload handler pretending otherwise. Use **Sign out**.
- This page is not a phone keystore. It does not block screenshots or extensions. A script running on this origin can read the page.
- The dev and preview servers bind to `127.0.0.1:5173` and send a Content-Security-Policy that allows connections only to this origin and loopback homeservers. The WASM file is built into `dist/assets`. There is no analytics script and no CDN script.

## Run

From `web/`, with Node 22.18 or newer:

```bash
npm ci
npm test
npm run dev
```

Open `http://127.0.0.1:5173`. The server field defaults to `http://127.0.0.1:8008`, which is the repository's Android/server Synapse port. Point it at whatever loopback Synapse you started yourself.

A production-style local bundle:

```bash
npm run build
npm run preview
```

`npm run preview` also listens on `127.0.0.1:5173` and serves only the files in `dist/`.

## Tests

`npm test` runs the in-memory unit tests and the UI tests (happy-dom). It does not start a homeserver.

The encrypted round trip is `npm run test:integration`. It is skipped unless `web/.local/fixture.env` exists. That file is gitignored. Create it with a **new** local Synapse. Do not point the test at an existing private server or reuse saved passwords from `server/data`.

```bash
./scripts/synapse-fixture.sh
npm run test:integration
./scripts/stop-fixture.sh
```

`synapse-fixture.sh` publishes `127.0.0.1:18408` only, creates two random users, and writes passwords to `web/.local/fixture.env` without printing them. It needs Docker and does not start if that port is already taken by something else. `./scripts/stop-fixture.sh` stops it. The integration test does not use those saved passwords. It registers two new users with the fixture's registration shared secret and keeps those passwords in memory for that process.

The integration test uses two Node copies of this client against that Synapse. It checks that the stored event type is `m.room.encrypted` with algorithm `m.megolm.v1.aes-sha2`, and that the plaintext marker is absent from the server JSON. It does not claim that this browser client has interoperated with the Android build. That still has to be tried later against the existing Android peer.

## Not in this build

- Persistent login, passphrase-unlocked storage, or WebCrypto wrapping of the access token.
- Matrix Authentication Service / OIDC.
- Key backup, recovery keys, or automatic identity reset.
- Public deployment, store publication, payments, or live revenue.
- A claim that an unload handler logs you out.
