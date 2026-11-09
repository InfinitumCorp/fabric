# FabriC++™ — v0.15 prototype

Infinitum's secure communications platform with an opt-in data economy. (`FABRIC` stays as the
code name in environment variables, protocol labels and storage keys.)
Product spec: https://infinitum-corporation.vercel.app/products/fabric

## Run

```bash
npm install
npm start          # http://localhost:8787
npm test           # 160 tests: Scalvs (+scalvs.veil tasks), linked phone numbers, groups, photos, files and voice messages, read receipts, typing, pinned/muted/archived chats, message actions (reply, edit, delete, reactions, forward), post-quantum session setup, Supabase snapshots, burner numbers, open on-device models and outgoing translation, calls at scale (TURN, simulcast, SFU nodes), Cumulus://ID sign-in, on-device AI, QR linking, sealed sender, large calls (SFU), phone, group calls, relay hardening, frame crypto, devices, backups, vault, ratchet, sessions, economy
```

To try two users in one browser, open `http://localhost:8787/?profile=alex` and
`http://localhost:8787/?profile=jordan` in two tabs (each profile is a separate device with its own keys).
To try a second device for alex, open `?profile=alexphone` and choose **Link this device**. On alex's
**Security → Devices**, choose **Scan QR code** and point the camera at it, or paste the code. Then check
that both screens show the same six-digit number and confirm on both.

The interface follows the Infinitum house style: white, hairline rules, square corners, Arial and
small uppercase monospace labels (all in `public/style.css`).

Calls: open a chat and press 📞 or 🎥. In a call, **Add person** rings another contact, and everyone in the
call links up with them. From 5 devices on, the call moves to the relay's SFU and can grow to 50 devices (see Large calls below). **Share screen** and **Camera on/off** work in voice calls too. Add `&media=test` to the URL to send a generated tone and test
pattern instead of your camera and microphone (handy for several tabs on one machine). The same
fallback kicks in when no camera or microphone is available.

Calls connect directly between devices. Across networks they need STUN/TURN servers. Pass them as JSON:

```bash
FABRIC_ICE_SERVERS='[{"urls":"stun:stun.example.org:3478"},{"urls":"turn:turn.example.org:3478","username":"u","credential":"p"}]' npm start
```

## Large calls (SFU)

Small calls are a full mesh: every device sends its media straight to every other one. Once a call reaches
5 devices (members plus pending invites), it moves to the relay's **SFU**, a media server inside the relay
process that forwards frames between members. It can't read them: every frame is still encrypted with the
sender's own key, and keys only travel in Double Ratchet messages between members. Up to 50 devices per call.

- **Speaker focus**: each device asks for at most 9 videos at once, people sharing their screen first, then whoever
  spoke last. Audio from everyone is always forwarded. Big calls switch to a compact grid.
- Each device has two connections to the SFU: one to send, set up once and never renegotiated, and one to receive,
  which the relay renegotiates as people join and leave.
- If the browser has no frame encryption, or the relay has the SFU turned off, the call stays a mesh (up to 8).
- Test the switch with fewer people by adding `&sfuFrom=3` to the URL.

| Variable | What it does |
|---|---|
| `FABRIC_SFU=0` | Turn the SFU off. Calls stay mesh-only. |
| `FABRIC_SFU_PUBLIC_IP` | The relay's public IP, announced as an extra ICE candidate (needed behind NAT or in a container). |
| `FABRIC_SFU_PORTS` | UDP port range for media, such as `40000-40999`. Open it in the firewall. |

### Simulcast

In a large call each browser uploads its video in three qualities (`l` = ¼ size at up to 150 kbps,
`m` = ½ size at up to 500 kbps, `h` = full size at up to 1.5 Mbps). Each viewer tells the SFU which
quality each tile needs: the first tile (presenter or current speaker) gets `h`, two to four tiles
get `m`, and a crowded grid gets `l`. The SFU forwards one layer per video. It only switches
layers at a keyframe, and it rewrites sequence numbers, timestamps and VP8 picture ids so the
viewer's decoder sees one continuous stream. If a sender stops sending its top layer (it is short
of bandwidth), viewers move to the next layer down. Frames stay end-to-end encrypted. The SFU reads
only the clear VP8 payload descriptor and the keyframe bit.

Chrome decides how many layers to send from the camera's resolution and the bandwidth it
measures (the SFU sends transport-cc feedback so Chrome can measure). A 640×480 camera gives two
layers and 720p gives three.

### Several SFU nodes per room

A relay can put large-call media on separate machines. Run `npm run sfu-node` on each one, then
point the relay at them. The relay keeps all signalling and decides where each member goes. A
member joins the node that already hosts most of its room, as long as that node has room left. When
no node has room, the least loaded node takes the member and dials every other node in the room.
The nodes then forward the still-encrypted RTP between themselves, and only the layers their viewers
need. If a node goes down, its members get `sfu_closed` and their clients rejoin on another node.

| Variable | Where | Meaning |
|---|---|---|
| `FABRIC_SFU_NODES` | relay | Comma-separated node origins, such as `wss://sfu1.example.com:8800`. When set, the relay forwards no media itself. |
| `FABRIC_SFU_NODE_SECRET` | relay and nodes | Shared secret (16+ characters). It signs one-minute tokens for the relay→node control socket and the node↔node links, each link token bound to one room. |
| `FABRIC_SFU_NODE_CAP` | relay | Members of one room per node before the room spills onto another node (default 25). |
| `SFU_NODE_PORT` | node | Listening port (default 8800). |
| `FABRIC_SFU_PUBLIC_IP`, `FABRIC_SFU_PORTS`, `FABRIC_TLS_CERT`, `FABRIC_TLS_KEY` | node | As for the relay. Use TLS whenever a node is on another machine. |

Node-to-node links run over TCP WebSockets. On a lossy link between nodes, one lost packet holds
up the packets behind it (head-of-line blocking). A node that falls behind drops video before audio.
Put the nodes in one data centre.

To try it locally, start the `sfu-node-1`, `sfu-node-2` and `fabric-scale` launch configurations
(relay on port 8789, cap 2). Then open three profiles with `?profile=…&media=test&sfuFrom=2` and make a
three-person video call.

### Operator TURN

| Variable | Meaning |
|---|---|
| `FABRIC_TURN_URLS` | Comma-separated `turn:`/`turns:` URLs of your TURN server. |
| `FABRIC_TURN_SECRET` | The TURN server's shared secret (coturn `static-auth-secret`). |
| `FABRIC_TURN_TTL` | Login lifetime in seconds, 300–86400 (default 3600). |

The relay never stores TURN passwords. A signed-in device asks for a login over its socket and
gets one that expires: `<expiry>:<random id>` signed with HMAC-SHA1, so TURN logs never name
anyone. `/api/ice` says only whether TURN exists. A coturn config with SSRF protection (private
ranges denied) is in [deploy/coturn/turnserver.conf](deploy/coturn/turnserver.conf).

## Cumulus://ID sign-in

[Cumulus://ID](https://infinitum-corporation.vercel.app/products/cumulus-exchange#cid) (CID) is the one
Infinitum account. FabriC++ is an OpenID Connect client of it (authorization code flow with PKCE). With CID on:

- **Security → Cumulus://ID → Link** ties your address to your CID. **Backup → Save to Cumulus** keeps your
  encrypted backup there.
- On a new device, **Restore backup → Sign in with Cumulus://ID** finds that backup. You still type its
  recovery key: Cumulus can't open it, and neither can the relay.
- With `FABRIC_CID_REQUIRED=1`, every new address needs a CID that has no address yet (one address per CID).
  This slows down mass sign-ups. Existing addresses keep working without one.

Until the real CID service is reachable, a development stand-in runs locally (test accounts, no passwords):

```bash
npm run cid-dev    # http://localhost:8790, allows http://localhost:8788/cid-callback.html by default (CID_DEV_REDIRECTS)
PORT=8788 FABRIC_CID_ISSUER=http://localhost:8790 FABRIC_CID_CLIENT_ID=fabric-dev npm start
```

| Variable | What it does |
|---|---|
| `FABRIC_CID_ISSUER` | The CID issuer URL (OpenID discovery at `/.well-known/openid-configuration`). Must be https, except on localhost. Unset = CID off. |
| `FABRIC_CID_CLIENT_ID`, `FABRIC_CID_CLIENT_SECRET` | FabriC++'s client registration at CID. The secret is optional (PKCE is always used). |
| `FABRIC_PUBLIC_URL` | The relay's public address. The redirect address registered at CID is `<FABRIC_PUBLIC_URL>/cid-callback.html`. |
| `FABRIC_CID_REQUIRED=1` | New addresses need a CID. |

How the sign-in works:

1. The relay starts it on your socket. It makes the state, the nonce and the PKCE verifier and keeps them.
2. A sign-in window goes to CID. If pop-ups are blocked, you get a link to a new tab instead.
3. CID sends that window back to `/cid-callback.html`, which passes the code to the FabriC++ tab over a
   same-origin BroadcastChannel.
4. That tab hands the code to the relay over the socket that started the sign-in. The relay swaps it for an
   ID token itself and checks it: ES256 or RS256 against CID's published keys, issuer, audience, expiry and nonce.

No CID token ever reaches the page. A code that arrives on any other socket is refused, and each sign-in
can be finished once, within 10 minutes. So a sign-in link sent to someone else can't tie their CID to the
sender's address.

## FabriC++ Phone (real phone numbers)

The **Phone** tab gives an account a real phone number: call and text any phone, receive calls in the browser,
and missed calls go to voicemail. It runs through a Twilio account owned by the relay operator.

1. In Twilio, buy a number. Create an **API key** and a **TwiML App** whose Voice URL is
   `https://<your relay>/api/phone/voice`. Set the number's Voice webhook to `/api/phone/incoming` and its
   Messaging webhook to `/api/phone/sms` (all HTTP POST, on your relay's public https URL).
2. Start the relay with:

| Variable | |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | the account; the auth token checks that webhooks really come from Twilio |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | signs browser access tokens, sends texts, fetches voicemail |
| `TWILIO_TWIML_APP_SID` | the TwiML App from step 1 |
| `FABRIC_PUBLIC_URL` | the relay's public URL exactly as Twilio calls it (used to check signatures) |
| `FABRIC_PHONE_COUNTRIES` | optional, calling codes users may call and text (default `+1`) |
| `FABRIC_PHONE_NUMBERS` | optional, `{"+15551234567":"@ana.veil"}` assigned at start |

3. Assign numbers to accounts: `POST /api/phone/numbers {"number":"+15551234567","handle":"@ana.veil"}` with the
   operator token (`{"handle":null}` releases a number).

**Phone calls and texts are not end-to-end encrypted.** The phone network can't be: Twilio and the other carrier
can hear calls and read texts, and the relay keeps phone history and texts for 30 days so every device sees them.
The Phone tab says this up front. FABRIC-to-FABRIC chats and calls are unaffected.

Toll-fraud guards: only allowed calling codes, no US premium-rate numbers (900/976), outgoing calls capped at
30 an hour and texts at 60 an hour per account, a 4-hour call limit, and caller ID is always the account's own number
or one of its own burners.

### Burner numbers (add-on, paused)

> **Off for now.** Burner numbers are out of the app until they come back in a later release. The relay keeps the code dormant: it reports no burners and refuses burner requests unless `FABRIC_BURNERS=1` is set, and the app has no burner screens. The rest of this section describes the feature as it will return.

Disposable numbers that stand in for you on calls and texts: people you reach from a burner see only the burner.
They're an add-on to the FabriC++ plan, in **bundles of 1, 2 or 5 numbers**, renewed monthly or yearly.

In the Phone tab, each one-tap action does one thing:
- **New burner number** takes one from the relay's pool.
- **Rotate** swaps a burner for a fresh number in one step. The old one is burned, but only once a new one has been
  found; conversations that used it move to the new one.
- **Burn** drops it for good after a 5-second Undo. It stops ringing at once, the relay deletes its calls and texts,
  and the number rests in the pool (90 days by default) so its callers don't reach the next person.
- The **From** list on the dialer shows, and sets, which number each conversation uses. Someone who reached you on a
  burner gets answered from that burner.
- Labels are only on your devices.

When a bundle runs out, the relay burns the lines it no longer covers.

What stays private: the full records (labels, rotation history, which number you use with whom) live in the
encrypted vault on the device, in the record format shared with ÆTHER (`shared/burner.js`, v1). The relay knows
only which number routes to which account, which is what it needs to ring you. Burner calls and texts are phone
calls like the rest of this tab: **not end-to-end encrypted**, handled by the carrier in the clear, and kept on
the relay for up to 30 days, or until you burn the number.

Operator side (payment happens outside the relay, for example at `FABRIC_BURNER_CHECKOUT_URL`):

| | |
|---|---|
| `FABRIC_BURNER_POOL` | comma-separated Twilio numbers bought for lending out, with the same Voice/Messaging webhooks as above |
| `POST /api/phone/pool {"add":[…],"remove":[…]}` | change the pool; `GET` shows total, free and lent (operator token) |
| `POST /api/phone/bundles {"handle","size":1\|2\|5,"period":"month"\|"year","id"}` | record a paid bundle; `id` makes it idempotent (e.g. the order id), optional `expiresAt` |
| `FABRIC_BURNER_COOLDOWN_DAYS` | how long a burned number rests (default 90) |
| `FABRIC_BURNER_CHECKOUT_URL` | https page the app's **Get** buttons open, with `?bundle=&period=` and nothing about the account |

New burners are rate-limited (6 at once, 12 a day per account) so nobody can churn through the pool.

`.claude/launch.json` has a `fabric-burner-demo` relay with a pool of three 555 test numbers and a local operator
token (`local-demo-operator-token`) for granting a bundle with curl.

`.claude/launch.json` has a `fabric-phone-demo` relay (port 8788, its own database) with placeholder Twilio
values. It shows the Phone tab and gets as far as Twilio, which then refuses the fake credentials.

## Scalvs (+scalvs.veil): text tasks to SCALVS.ai

Scalvs is SCALVS.ai, Infinitum's AI workforce, as a FabriC++
contact. Add **+scalvs** (the app turns it into +scalvs.veil) and text it a task. It does the task and
replies in the same chat, with a read receipt and a typing indicator while it works.

| Send | Scalvs does |
|---|---|
| `help` | lists what it can do |
| `calc 2*(3+4)^2`, or just `7*6` | arithmetic (parsed, never `eval`) |
| `time`, `time Europe/Berlin` | current date and time |
| `remind me in 20m to call Ana` | texts you back when it's due (s, m, h, d; up to 7 days, 10 at a time) |
| `reminders`, `cancel reminders` | lists or clears your reminders |
| `roll 2d6`, `uuid`, `password 20`, `ping` | small utilities |
| anything else | an **AI task** (write, summarise, translate, plan, explain), when the operator turned AI tasks on |

How it stays end-to-end encrypted: Scalvs is an ordinary FabriC++ device, not a relay feature. It has its
own account key, device keys, signed device list and prekeys, signs in over the relay's WebSocket like the
browser, and runs Double Ratchet with each of your devices. Your app sends to it sealed (it hands out its
delivery key in its replies), so the relay doesn't learn who writes to it. The relay only reserves the handle
for Scalvs's account key: nobody else can register +scalvs.veil, even while Scalvs is turned off.

AI tasks leave end-to-end encryption on purpose: Scalvs decrypts the message and sends it to Anthropic's API
(Claude Opus 5.5, low effort, with server-side fallback on a safety decline). Its `help` says so. Built-in
tasks never leave the relay host. Scalvs keeps the last few turns of a chat in memory for context (forgotten
after an hour idle, never written to disk) and logs only which kind of task ran.

| Variable | What it does |
|---|---|
| `FABRIC_SCALVS=0` | Don't run Scalvs. The handle stays reserved. |
| `FABRIC_SCALVS_STATE` | Where Scalvs keeps its keys, ratchet state and pending reminders (default: `scalvs.json` next to `FABRIC_DB`). **Secret**, like the database: whoever holds it can read what people send Scalvs. |
| `FABRIC_SCALVS_AI_KEY` | Anthropic API key for AI tasks (falls back to `ANTHROPIC_API_KEY`). Without one, Scalvs runs built-in tasks only. |
| `FABRIC_SCALVS_AI=0` | AI tasks off even with a key set. |
| `FABRIC_SCALVS_MODEL` | Model for AI tasks (default `claude-opus-5-5`). |
| `FABRIC_SCALVS_AI_DAILY` | AI tasks per account per day (default 50). |

Each account gets 20 tasks per 10 minutes. `GET /api/scalvs` says whether Scalvs and AI tasks are on.

## On-device AI beyond Chrome

Browsers without a built-in model (Firefox, Safari, mobile, older Chrome) run open models in a worker with
Transformers.js 4.3 (WebAssembly, or WebGPU for the assistant when the GPU supports 16-bit floats). Each
feature picks the browser's own model first, then the open one, then the simple local fallback.
Security → On-device AI shows which engine each feature uses and how big the download is.

| Feature | Open model | Download |
|---|---|---|
| Translation | Opus-MT (`Xenova/opus-mt-*`, 8-bit), one model per direction; pairs without a direct model go through English | ~113 MB per direction |
| Summaries, suggested replies | Qwen2.5-0.5B-Instruct (`onnx-community`), 4-bit/16-bit on WebGPU, 8-bit on WebAssembly | ~480–510 MB |
| Language detection | `shared/langdetect.js` (script, common words and letters), no download | — |

Languages: Spanish, French, German, Italian, Russian, Chinese, Japanese, Dutch, Arabic, Hindi, Ukrainian,
Swedish, Vietnamese and Indonesian both ways with English; Korean, Turkish and Polish into English only.

**Outgoing translation**: the composer's **Send in** list picks the language of the person you're writing
to (theirs comes first). Pressing Send first shows the translation, which you can edit; nothing is sent until
you press **Send in …** there. The message carries your original inside the encryption, so they can tap
*show what was sent* and you can tap *as you wrote it*. Their device doesn't translate it again.

Model files come through the relay (`/models/…`), which fetches them from Hugging Face once, keeps them in
`data/models` and serves every later device from there. Only the listed models and the files they need
pass. The runtime (`/vendor/transformers.js`, `/vendor/ort/*`) comes from `node_modules`. The page's CSP
adds only `'wasm-unsafe-eval'`, and the relay sends `Cross-Origin-Embedder-Policy: credentialless` so
WebAssembly can use several threads. Try it in Chrome with the built-in models hidden: `?media=test&ai=open`.

| Variable | What it does |
|---|---|
| `FABRIC_MODELS=0` | Turn the model pass-through off (browsers with a built-in model still have AI). |
| `FABRIC_MODEL_SOURCE` | Where model files come from (default `https://huggingface.co`; any mirror with the same `/<org>/<repo>/resolve/main/<file>` layout). |
| `FABRIC_MODEL_DIR` | Cache folder (default `data/models`). Files placed here by hand are served without asking the source. |

## Desktop app (Windows, macOS)

`desktop/` is FabriC++ for the desktop: a thin Electron shell around the web client the relay serves, the same way `android/` wraps it in a WebView. Crypto, the vault and calls all run in the page exactly as in a browser. The shell adds:

- **One origin.** Release builds load only `https://relay.infinitumfabric.app/`, and nothing can repoint them: command-line arguments, environment variables, a second launch and the page itself are all ignored. The relay serves the app's code, so this matters. Any link to another origin opens in the system browser. Pop-ups, `<webview>` and navigation away from the relay are blocked.
- **Calls.** Camera, microphone, notifications and screen capture are granted only to the relay's own page. Every other permission, plus USB, HID and serial devices, is refused. macOS asks the OS once per device and shows its own screen picker (macOS 15+). Windows has no OS picker an app can call, so a small FabriC++ picker lists screens and windows, and nothing is shared until you pick one.
- **Desktop behavior.** Single instance (launching it again focuses the window). Closing the window hides it to the tray so messages and calls keep arriving, and Quit is in the tray menu. The window title is always "FabriC++™". Unread chats show as a square accent marker on the tray icon and taskbar (Windows) or a dock badge (macOS). Message notifications go through the OS.
- **Branding.** The F from `public/brand/`, copied at build time by `desktop/tools/icons.js` (no separate artwork). While the relay's page loads, a boot screen shows the F and wordmark centered on white, matching the web `#boot` screen. If the relay can't be reached, it offers a retry.

Build (Node 22+, no admin rights needed; Electron and the NSIS tooling are downloaded on first build):

```
cd desktop
npm install
npm run dist        # release: dist/FabriC++-Setup-<version>.exe (per-user installer) and dist/FabriC++-<version>-portable.exe
npm run dist:dev    # dev build that loads http://localhost:8795/ instead (output in dist-dev/)
npm run dev         # run from source against http://localhost:8795/
npm run smoke       # end-to-end check against a local relay on :8795 (sign-in, message, voice call, origin lock)
```

On a Mac, `npm run dist` produces a `.dmg` and `.zip`, with camera and microphone usage strings in Info.plist. Builds are unsigned for now: Windows SmartScreen and macOS Gatekeeper will warn until a code-signing certificate is configured (`CSC_LINK` / `CSC_KEY_PASSWORD` for electron-builder). Dev builds keep their own profile ("FabriC++ Dev"), so they never share a vault with the release app.

## Running a relay

State lives in SQLite (`data/fabric.db`, Node's built-in `node:sqlite`, so Node 22.5+). On first start an
existing `data/state-v3.json` is imported once and renamed to `.imported`.

| Variable | What it does |
|---|---|
| `FABRIC_OPERATOR_TOKEN` | Bearer token for `/api/economy/settle` and the full ledger. Without it, settlement only works from the machine itself (no proxy). |
| `FABRIC_TLS_CERT`, `FABRIC_TLS_KEY` | PEM files. Serves HTTPS/WSS and sends HSTS. |
| `FABRIC_ORIGINS` | Comma-separated origins allowed to open a WebSocket. Default: the relay's own host. |
| `FABRIC_TRUST_PROXY=1` | Take the client IP from `X-Forwarded-For` (only behind your own proxy). |
| `FABRIC_ICE_SERVERS` | STUN/TURN list for calls (see above). |
| `FABRIC_SFU`, `FABRIC_SFU_PUBLIC_IP`, `FABRIC_SFU_PORTS` | Large-call media server (see Large calls). |
| `FABRIC_SFU_NODES`, `FABRIC_SFU_NODE_SECRET`, `FABRIC_SFU_NODE_CAP` | Separate SFU media nodes (see Several SFU nodes per room). |
| `FABRIC_TURN_URLS`, `FABRIC_TURN_SECRET`, `FABRIC_TURN_TTL` | TURN server run by the operator, with short-lived logins (see Operator TURN). |
| `FABRIC_MODELS`, `FABRIC_MODEL_SOURCE`, `FABRIC_MODEL_DIR` | Open on-device models (see On-device AI beyond Chrome). |
| `FABRIC_NUMBER_PEPPER`, `TWILIO_VERIFY_SERVICE_SID` | Linked phone numbers (see docs/number-linking.md): a 32+ character pepper that keys the stored hash, and the Twilio Verify service that texts the codes (uses the Twilio API key or account credentials). `FABRIC_LINK_COUNTRIES` limits calling codes (default +1). `FABRIC_NUMBER_VERIFY=dev` writes codes to the relay log instead, and only works when every `FABRIC_ORIGINS` entry is localhost. |
| `FABRIC_BURNERS` | `1` turns burner numbers on. Off by default; the app has no burner screens for now. |
| `FABRIC_BURNER_POOL`, `FABRIC_BURNER_COOLDOWN_DAYS`, `FABRIC_BURNER_CHECKOUT_URL` | Burner numbers, when on (see Burner numbers). |
| `FABRIC_SUPABASE_STORE`, `FABRIC_SUPABASE_KEY`, `FABRIC_BACKUP_KEY` | Supabase as system of record (see below). |
| `FABRIC_BACKUP_NAME`, `FABRIC_BACKUP_MINUTES` | Snapshot name (default `relay`) and how often to check for changes (default 2 minutes). |

### Supabase backend

SQLite stays the relay's working copy; Supabase holds the record. When `FABRIC_SUPABASE_STORE` is set, the
relay seals a consistent snapshot (`VACUUM INTO`, then AES-256-GCM under `FABRIC_BACKUP_KEY`) and uploads it
whenever its data changed, and once more on shutdown. A relay started on a fresh host with no local database
restores the latest snapshot first, so the relay machine is replaceable. Supabase only ever holds ciphertext.
Keep `FABRIC_BACKUP_KEY` somewhere other than Supabase: without it the snapshots cannot be restored.

Uploads go through the `fabric-store` edge function (`supabase/functions/fabric-store`, deploy with JWT
verification off; it checks its own key). The relay presents `FABRIC_SUPABASE_KEY`, whose SHA-256 must be in
`fabric.gateway_keys` (schema `fabric`, RLS on, not exposed over REST). The service-role key never leaves Supabase. Snapshots live in the private
`fabric-relay` bucket. Set up with `supabase/migrations/20261107_fabric_store.sql`.

## What works

| Area | v0.15 |
|---|---|
| Identity | `@name.veil` addresses. An account has an **account signing key**, held only by the primary device (and in backups). Each device has its own DH + signing keys. The account key signs the **device list** (`version`, devices, public keys). The relay only accepts lists signed by the pinned account key, with a higher version each time, and registration needs proof of the device's private key. Contacts verify the list themselves, so a relay that adds a device to someone's account can't sign it. |
| Multi-device | Up to 6 devices. Messages fan out to every device of the contact, and a sync copy goes to your own other devices so they show what you sent (only one copy counts for the data economy). Each pair of devices has its own ratchet session, so copies don't share keys. Contacts see a note when you add or remove a device. **Linking**: the new device shows a one-time code (relay mailbox + ephemeral key) as a **QR code** and as text. The primary scans it with the camera (the browser's BarcodeDetector, or jsQR served by the relay; frames never leave the page) or takes it pasted. The primary sends its own ephemeral key and the account it's linking into. The new device answers inside the encrypted channel with its keys and a fresh nonce. Both screens then show a **six-digit confirmation number** over both keys, the account, the handle and the nonce. Only when you confirm on the primary does it sign the new list and send contacts and recent history, and only when you confirm on the new device does it join. If the numbers differ, either side cancels and nothing is linked. **Removing** a device signs a new list. The relay signs it out (close 4001), drops its prekeys and queue, and refuses it from then on. |
| Voice & video | 1:1 WebRTC calls with mute, camera toggle and a call log in the chat (duration, missed, declined, answered elsewhere). **Signaling goes through the Double Ratchet**: offer, answer and hangup are encrypted chat-session messages, so the relay never sees SDP, IP candidates or keys. The SDP carries the DTLS fingerprints, so authenticating it this way makes DTLS-SRTP end to end. **Frame E2EE on top** (SFrame-style): every encoded audio and video frame is AES-256-GCM encrypted in a worker (`RTCRtpScriptTransform`, or Chrome's `createEncodedStreams`) with a fresh per-call, per-direction key exchanged in the same encrypted messages. Codec headers stay clear but authenticated, and calls with frame E2EE use VP8. The call screen counts frames encrypted and decrypted. An invite rings **every device** of the contact. The first to answer takes the call and the others stop ringing. Busy, glare (both call at once), 45 s ring timeout and stale invites from an offline queue (missed call) are handled. |
| Group calls | Add people to any call, up to 8 devices in a full mesh (every device sends to every other one, so no media server ever holds decrypted media). Each member announces who is in the call to the others, and any two members not yet connected link up (the smaller address sends the offer). Someone added by a member is accepted only if that device is on their account's signed device list, so a relay can't slip in an extra device. **Sender keys**: each device encrypts its frames with its own key and gives that key only to the members present. Every device makes a new key whenever someone joins (newcomers can't read what came before) or leaves (people who left can't read what comes next), and every 10 minutes. Frames carry a one-byte key id so receivers switch over without gaps. Screen sharing and turning the camera on mid-call swap tracks without renegotiating. |
| Sealed sender | The relay delivers messages and call signals **without learning who sent them**. Each envelope is sealed to the recipient device's key (ephemeral ECDH, AES-256-GCM) and sent over a second socket that never signs in. Inside, a second layer keyed by both devices' keys proves the named sender made it, so nobody can put a message under someone else's name. Contents are padded to 1, 2, 4, 8 or 16 KiB. Lookups and prekey fetches go over the same socket, so the relay doesn't see whom you are about to write to either. To stop anonymous spam, each account has a **delivery key**, given only to people it writes to (inside ratchet messages). The relay accepts a sealed envelope only with the recipient's key, and rate-limits per IP and per recipient device. Messages to someone who never wrote to you go named, as before. Sent messages show "sealed", and Security shows how many contacts you reach sealed. |
| Large calls | From 5 devices, the call moves to the relay's **SFU** (up to 50 devices), which forwards frames still encrypted with each sender's key. Members agree on one room (the smaller id wins if two rooms meet) and drop their mesh links once the SFU carries a member. Sender keys rotate on every join and leave, as in mesh calls. Speaker focus forwards at most 9 videos per viewer, presenters first, then recent speakers, and asks the sender for a keyframe when the view changes. A member the SFU stops reporting for 10 s is dropped. **Simulcast**: each sender uploads l/m/h qualities and every tile gets the one its size needs, switched at keyframes. **Several SFU nodes**: a room spills across media nodes joined by authenticated links. **Operator TURN** with short-lived logins issued only to signed-in devices. |
| Phone | A real number per account through Twilio: calls out and in (in the browser), voicemail, SMS, and a shared call history on every device. Not end-to-end encrypted (see FabriC++ Phone above). Webhooks are checked with Twilio's signature, and the Twilio Voice SDK is served from the relay itself, so the page still loads no third-party script. Burner numbers are paused (see Burner numbers). |
| Cumulus://ID | Sign in with the Infinitum account through OpenID Connect + PKCE, with the code exchanged by the relay. **Link** an address (one per CID), **Save to Cumulus** (the same encrypted backup, up to 16 MB, through one-use upload tickets), **restore on a new device** by signing in and entering the recovery key, and optionally **require a CID for new addresses**. The relay stores `HMAC(relay secret, issuer, sub)`, not CID's id for you, your email or any token. Contacts never see your CID. Unlinking deletes the cloud backup. |
| Backup & restore | **Download backup file** or **Save to Cumulus** (primary only, needs the passphrase if one is set). Either one makes an AES-256-GCM file with the account key, contacts and history, and shows a new 160-bit **recovery key** once (32 Crockford base32 characters, typos like O/0 tolerated). Type an existing recovery key to keep using it instead. **Restore** on a new device (from a file, or from Cumulus after signing in) decrypts it, makes fresh device keys and signs the next list version, which makes this device the primary. Remove the lost device from there. Ratchet sessions and prekeys are never in a backup, so restoring can't reuse old message keys. |
| E2E messaging | **X3DH + Double Ratchet** (Signal design, on P-256). Every message has its own key, which is deleted after use (forward secrecy). Every reply starts a new DH step, so a stolen device state stops working after a round trip (post-compromise security). Handles out-of-order and lost messages (up to 1,000 skipped per chain). Identities and routing fields are bound as AAD. Offline store-and-forward, resend after reconnect, dedupe. |
| Prekeys | A signed prekey (rotated weekly, previous one kept) plus 50 one-time prekeys, topped up automatically below 15. The relay checks prekey signatures and hands out each one-time prekey once. The client checks signatures again. |
| Key storage | Identity private keys are **non-extractable** CryptoKeys: page script can use them but can't read them out. Everything on the device (history, contacts, ratchet sessions, prekeys) is encrypted with AES-256-GCM in IndexedDB. An optional **passphrase** (PBKDF2-SHA256, 600,000 iterations) wraps the storage key, so a copied browser profile is useless without it. The Security tab sets, changes or removes it and can lock the app. v0.2 plaintext profiles migrate automatically and the old copy is deleted. |
| Send safety | The new ratchet state is written to disk (strict durability) before a message leaves the device, so a crash can't make it reuse a message key. |
| Page hardening | Strict Content-Security-Policy (same-origin scripts only, no inline code, no framing), plus nosniff, no-referrer and same-origin opener isolation. |
| Trust | 60-digit safety numbers over both **account keys**, so they stay the same when devices are linked, removed or restored. A verified mark, and a hard stop if a contact's account key changes. Messages that arrive during the stop are held, then opened once you accept the new key. |
| On-device AI | Summaries, live translation of incoming messages, and up to three suggested replies, all run by the browser's built-in model on this device (Chrome 138+ desktop: Summarizer, Translator, LanguageDetector, Prompt API). Other browsers run open models (Opus-MT, Qwen2.5-0.5B) in a worker with Transformers.js. Outgoing messages can be translated into the other person's language before sending, with a preview you can edit. Models download once, only after a tap. Without any model, summaries fall back to the simple local one. Status and switches are in Security → On-device AI. |
| Relay storage | SQLite in WAL mode with `synchronous=FULL`. Every change is committed before the relay acknowledges it, so a crash or restart loses nothing it said it stored. Multi-step changes (consent + ledger entry, device removal) are single transactions. |
| Delivery | **Store until acknowledged**: the relay keeps each envelope until the receiving device confirms it saved it (`got`), and redelivers on every reconnect. Clients drop duplicates by sender and message id, so a lost ack never shows a message twice or a false decryption error. Queues hold up to 1,000 envelopes per device and expire after 30 days. |
| Abuse limits | Token-bucket rate limits per IP (connections, HTTP, pre-login lookups) and per device (messages, sends, lookups, bundles). **One-time prekey drain protection**: a requester gets 2 one-time prekeys per contact device, then 1 per 10 minutes, and a device hands out at most 20 per hour overall. Past that, bundles come without one and sessions use 3-DH. At most 32 sockets per IP, heartbeats drop dead connections, and malformed input gets an error, never a crash. |
| Operator & transport | Settlement and the full ledger need the operator token. WebSocket origins are checked. Optional TLS with HSTS. The public economy and ledger endpoints show aggregates only (participant count, ledger validity and head). Your own share preview is sent over your authenticated socket. Revenue-share counters are capped per day per purpose, so one account can't inflate its weight. |
| Data economy | Opt in per purpose (usage, network quality, product research), all off by default. The relay counts metadata only for purposes you opted into, never contents. Sealed messages don't say whose they are, so a device with Usage on reports its count itself, in one batch at a random time 30–90 minutes later (same daily caps). Consent receipts are kept. |
| Revenue share | The 70/30 split with contribution weighting and cent-exact rounding (the product page's $100k → $7.00/user example is a test). Settlements are written to a hash-chained ledger (stand-in for Firmament Network) and credited as $FAB (demo rate 10 FAB/USD). |

## Layout

```
shared/crypto.js     identities, signatures, safety numbers, relay proofs
shared/devices.js    signed device lists, addresses, link codes
shared/channel.js    link channel, recovery keys, encrypted backups
shared/callproto.js  call signal validation, glare, timeouts
shared/qr.js        QR code encoder for link codes
shared/sealed.js    sealed sender: two-layer envelope, padding, delivery keys
shared/frame-crypto.js  media frame encryption (SFrame-style, with key ids)
shared/ratchet.js    X3DH / hybrid post-quantum (v3) setup + Double Ratchet (runs in the browser and in Node)
shared/pq.js         ML-KEM-768 from @noble/post-quantum (node_modules in Node, /vendor/noble/ in the browser)
server/backup.js     sealed SQLite snapshots to Supabase (fabric-store edge function)
shared/session.js    sessions per contact device, prekey upkeep, serialized ops
shared/vault.js      encrypted local storage, passphrase wrapping
shared/economy.js    purposes, weights, 70/30 allocation
server/cid.js        Cumulus://ID client: discovery, PKCE, code exchange, ID-token checks
server/cid-dev.js    local development stand-in for Cumulus://ID (OpenID provider, test accounts)
public/cid-callback.js  where the CID sign-in window returns; hands the code to the app tab
shared/summarize.js  simple local summary (fallback when no model)
shared/ai.js         prompt building, output cleaning, reply parsing, language choice
shared/models.js     open models: translation pairs and routes, assistant model, allowed files
shared/langdetect.js language detection without a built-in detector
server/relay.js      device-list directory, link mailboxes, ciphertext relay, consent, ledger, static server
server/store.js      SQLite storage, queues, counters, hash-chained ledger, legacy import
server/limits.js     token buckets, socket and daily caps
server/sfu.js        SFU: rooms, upload/download connections, simulcast forwarding, speaker view, node links
server/simulcast.js  VP8 descriptor parsing, layer choice, keyframe-aligned layer switching
server/sfu-node.js   standalone SFU media node (relay control socket, node-to-node links)
server/sfu-link.js   node tokens and link wiring
server/sfu-cluster.js the relay's placement of members across nodes
server/turn.js       short-lived TURN logins (shared-secret scheme)
server/phone.js      FabriC++ Phone: Twilio tokens, webhooks, voicemail, SMS, burner lines
shared/burner.js     burner number record (shared with ÆTHER), bundle sizes, rotate/burn rules
server/models.js     model file pass-through: allowlist, disk cache, ranges
server/scalvs.js     Scalvs: SCALVS.ai as the contact +scalvs.veil (its own device, keys and ratchet sessions)
server/scalvs-tasks.js  Scalvs built-in tasks (calc, time, reminders, ...) and the AI hand-off
server/scalvs-ai.js  Scalvs AI tasks through the Anthropic API
public/idb.js        IndexedDB backend for the vault
public/calls.js      call engine (1:1, group mesh, SFU) and call screen
public/ai.js         on-device models: feature detection, engine choice, downloads, summaries, translation, replies, test fakes
public/ai-worker.js  runs the open models (Transformers.js) off the main thread
public/phone.js      Phone tab: dialer, texts, voicemail, history
public/e2ee-worker.js  frame encrypt/decrypt worker
public/              web client
test/                node:test suites
```

## Crypto notes

- Curve: P-256 everywhere, because WebCrypto has it in every browser. Signal uses X25519 with XEdDSA. Switching to X25519/Ed25519 touches only the key helpers in `shared/crypto.js`.
- Post-quantum session setup (v3, after Signal's PQXDH): every signed prekey carries an ML-KEM-768 key, signed by the device for that prekey id. The initiator encapsulates to it and mixes the 32-byte shared secret into the same HKDF as the P-256 DHs, so recorded traffic can only be read by someone who breaks both P-256 and ML-KEM ("harvest now, decrypt later" is covered). The version is bound into the associated data, and the KEM ciphertext travels in the setup header, which is in every message's AAD, so a changed or stripped ciphertext fails to decrypt rather than making a weaker session. A PQ key that fails to verify is refused, never a reason to fall back. Peers on an older app (no PQ key in their bundle, or a setup without one) still get v2. Once a device has used v3 with you, it is pinned: setups without PQ are refused both ways, so a relay that strips PQ keys later gets an error, not a downgrade. The first contact with a device can't be protected that way. The Double Ratchet steps after setup are still P-256 only, as in PQXDH: a future quantum attacker who recorded everything could break later ratchet steps, so a PQ ratchet (Signal's SPQR) is the next step. ML-KEM comes from `@noble/post-quantum` (MIT; see THIRD_PARTY_NOTICES.md), served from `node_modules` at `/vendor/noble/`. The chat header shows "post-quantum" when every session with that contact is v3.
- Signal's optional header encryption isn't used, so the relay can see message counters and ratchet public keys, but nothing else.
- If both sides start a session at the same moment, each keeps both sessions (up to 3 per contact) and tries them in turn. Tests cover this.
- One-time prekeys are rate limited per requester and per target, so draining them takes many accounts and time. When they do run out, sessions fall back to 3-DH, which is still secure but loses the one-time key.
- Sealed sender hides the sender of a message from the relay, not the recipient, the time or the padded size. The relay still sees the IP address each socket comes from. Both of a device's sockets usually share one, so a relay that logs IPs can match them up. Sealed sender protects against a relay that keeps only what it's sent; a VPN or Tor is needed against one that also watches the network. The unregistered socket is replaced every 10 minutes, so not all of a device's sends are linked to one connection. Unlike Signal's server-signed sender certificates, nothing here is signed by the relay: the recipient checks the sender against that account's own signed device list.
- The outer layer is encrypted to the recipient device's long-term DH key. Someone who later steals that key and has recorded the relay's traffic can see who sent those envelopes, but still can't read them (the ratchet keys are gone). Rotating the delivery key (`rotate_delivery_key`) cuts off anyone who has it, and contacts fall back to named sends until your next message brings them the new one.
- A delivery key is a permission, not a secret from the relay: the relay checks it on every sealed send. Everyone you write to holds the same key, so it doesn't identify which of them sent something.
- Old stored data (`fabric:v1:*` profiles, `data/state.json`, `data/state-v2.json`) is ignored. v0.2 profiles migrate into the vault on first load. A v0.3 vault becomes a primary device on unlock: it gets a new account key and device id and re-registers. Contacts are re-pinned on the next lookup and marked unverified, so check safety numbers once more.
- Device model: close to Signal's Sesame, but with an account-signed device list rather than a server-asserted one. Rolling back to an older list is refused by both the relay and contacts. A restored backup holds the account key, so it can sign lists just like the primary. Treat the backup file and recovery key like the account itself, and store them apart.
- Linking sends the new device's keys to the primary inside an AES-GCM box keyed by ECDH between two ephemeral keys. The new device's key travels in the code (QR or text), and the primary's key arrives through the relay mailbox. The confirmation number closes the two ways in: a swapped code (say, clipboard malware pasting the attacker's code) gives the primary a different number than the real new device shows, and a relay that swaps the primary's key, or hands the new device a look-alike account with the same handle, gives the new device a different number. The new device's nonce is only revealed inside the channel, after the primary's key is fixed, so an attacker can't search for keys that produce a matching number: they match by luck, one chance in a million. The new device also checks that the list it receives is signed by the account key it was shown.
- The QR encoder (`shared/qr.js`, byte mode, level M, versions 1–10) is our own. A link code fits version 7. jsQR 1.4.0 (Apache-2.0) is the camera fallback, served from `node_modules` at `/vendor/jsqr.js`, and the tests use it to read back every version.
- Limits of browser key storage: non-extractable keys stop a script from *exporting* them, but a script running in the page while it's unlocked (XSS, a malicious extension) can still *use* them. The CSP is the defense there. In device mode the browser keeps the storage key on disk without hardware protection, so the passphrase is what protects against a copied profile. Ratchet and prekey private keys are encrypted inside the state blob, not held as CryptoKeys, because the ratchet has to serialize them.
- Calls: if either browser lacks encoded transforms, the call falls back to DTLS-SRTP only, still authenticated through the ratchet, and the call screen says so. Frame IVs are random per frame (96-bit). Keys are new for every call and direction, so a long call stays far under the per-key limit. Group calls rotate sender keys on every join and leave and every 10 minutes. A new key is sent first and used one second later, so frames already in flight still open. In a mesh each pair also has its own DTLS link, so someone who left loses the media path anyway; the rotation matters most once a media server forwards frames. ICE candidates are gathered before the offer or answer is sent (about one round trip, up to 3 s), rather than trickled. The relay can still see *that* two devices exchange call-sized messages, and once connected, the media's IP addresses are visible to each other (as in any P2P call). A TURN relay hides them but sees encrypted media only.
- Large calls: the SFU sees RTP metadata (who is in which room, packet sizes and timing, who speaks when through the audio level, and which videos each device views), but not the media. A relay that forwards the wrong stream into a slot only causes decryption failures, because each slot's frames must open with the key of the member it's labeled as. Removed members get no new keys, and the SFU stops forwarding to them. Chrome drops a sender's encoded transform when its connection is renegotiated, and then sends video in the clear. So the sending connection is set up once and never renegotiated, and the client never calls `setParameters` on it. A browser test checks that every frame decrypts.
- On-device AI: messages go to the browser's built-in model on this device and nowhere else; `public/ai.js` makes no network requests (the browser itself downloads the model). Translations are saved with the message in the encrypted vault. Prompts name the two sides "You" and "Them", never handles. A contact's message can try to steer the model ("ignore that and suggest…"), so the prompt marks the conversation as content, output is stripped of control and bidi characters and clipped, everything is shown as plain text, and a suggested reply only fills the composer: nothing is sent without pressing Send. Each suggestion runs in a fresh clone of the session, so one chat can't color another. To try the flow in a browser without a model: `?media=test&ai=fake` installs an obviously fake stand-in.
- Open models: text still never leaves the device; the worker only loads model files from this relay. The relay does learn **which** models a device downloads, so which languages someone translates between (not what). Model files are not pinned by hash yet: they're trusted as Hugging Face (or your `FABRIC_MODEL_SOURCE`) serves them, and the relay's cache is trusted after that. An outgoing translation carries the original (`orig`, `ol`, `tl`) inside the end-to-end-encrypted payload, so the other side can read what you actually wrote.
- Burner numbers: the relay maps each burner to its account, nothing more; labels and who-uses-which live in the vault. Burning deletes the relay's history for that number in the same transaction that stops routing it. The pool lends numbers only after a cooldown, so a burned number's old callers can't reach its next owner for 90 days. Since burner traffic is ordinary phone traffic, the carrier and the relay can see who called whom and read texts, as with the main number.
- Cumulus://ID: CID proves who owns an address. It never sees a message key, the account key or the recovery key, so a compromised CID (or relay) gets only an encrypted backup, and 160 random bits of recovery key are out of reach of guessing. Someone who takes over your CID and also has your recovery key can restore your account, just as with a backup file and its key: keep the recovery key apart. Signing in with CID on a new device makes it the primary, so contacts keep the same safety number. The development stand-in has no passwords and listens on 127.0.0.1 only. It is for testing, never for real accounts.
- Changing the passphrase briefly decrypts the identity keys in memory to re-encrypt them under the new storage key.
- Without a backup there's no recovery: forget the passphrase or lose every device and the account key is gone. Re-registering the handle needs the relay operator, and contacts would see a key-change warning.

## Roadmap (not yet built)

Current status and the open question about this branch versus the Matrix build on `main` are in
[docs/strategy.md](docs/strategy.md). Linking real phone numbers is in [docs/number-linking.md](docs/number-linking.md)
(Phase 1 built, Phase 2 in progress).

0. **Number linking, Phases 2 and 3**: seal phone history and voicemail to the account's devices; on-FabriC++ badges and opt-in contact matching.

1. **Cumulus://ID beyond sign-in**: connect the real CID service (client registration, passkey sign-in on its side), keep the Cumulus backup up to date automatically, send Earn payouts to the CID's FIRM Wallet, and store backups in FIRM Vault.
2. **Calls at scale, further**: SFU nodes in several regions (members placed by latency), node links over QUIC or SRTP instead of TCP, and VP9/AV1 SVC instead of simulcast.
3. **On-device AI, further**: SHA-256 pinning of model files, the missing pairs (English→Korean/Turkish/Polish, Portuguese), translation on WebGPU, and a smaller assistant for phones.
4. **$FAB on Solana**: SPL token, payouts to FIRM Wallet, settlement hashes anchored on Firmament.
5. **Transports**: ÆTHER mesh (burner records are already compatible: `aether-mesh` numbers), Spectre CRM logging (opt-in), E(O)N voice.
6. **Buyer side**: approved-buyer licensing, aggregation with k-anonymity or differential privacy before any sale.
7. **Relay scale & privacy**: sybil resistance for handle registration, several relay processes sharing one database (Postgres), and per-account storage quotas.
8. **Burner numbers, further**: real checkout and billing (Stripe or the Infinitum plan) wired to `/api/phone/bundles`, buying pool numbers from Twilio automatically when the pool runs low, a signed remote "burn all" for a lost device, and numbers outside +1.
