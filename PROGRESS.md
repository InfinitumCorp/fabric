# FabriC++ progress

Status on 2026-11-18. The full feature list, settings and layout are in [README.md](README.md).

## Where FabriC++ runs

| Piece | Where | Notes |
|---|---|---|
| Relay and web client | `https://relay.infinitumfabric.app` on the Yandex Cloud server `fabric-russia` | DNS only, no Cloudflare proxy, so it is reachable in Russia without a VPN. nginx terminates HTTPS (Let's Encrypt) in front of the `fabric-relay` systemd unit. |
| Landing page | `https://infinitumfabric.app` (Cloudflare) | `.github/workflows/auto-deploy.yml` deploys `main` every 30 minutes once CI is green. Cumulus ID and billing return links live here as Android App Links. |
| Android (WebView shell) | `android/` | Loads the relay web client. Release builds are signed with the FabriC++ release key. |
| Android (native) | `android-native/` | Kotlin app with Cumulus ID sign-in (Russia mirror fallback), plans and billing, Amplitude. Talks to the relay host. |
| Desktop | `desktop/` | Electron app for Windows and macOS. Loads the relay web client. Builds are unsigned. |
| React Native app | `app/` | Expo app from the Matrix track with Cumulus ID sign-in and billing screens. |

## Rules these builds follow

- Sign-in is Cumulus ID everywhere, with "Create a Cumulus ID" in the same flow, and a mirror (`ru.id.cumuluscloud.app`) where Cloudflare is throttled.
- Amplitude: page views and sessions only (Browser SDK 2.49.2 vendored, Android SDK 1.37.1). On the web it waits for a clean URL, so sign-in secrets in the URL never reach a page view.
- The repository is public until launch: no keys, passwords or `.env` files in git.

## Open

- **Desktop code signing.** Windows needs a code-signing certificate (Azure Trusted Signing is about $10 a month); macOS needs the Apple Developer Program ($99 a year). Not bought; builds stay unsigned until William decides.
- **SSH to the Yandex servers** times out from the office PC since its public IP changed; the security group needs the new IP. HTTPS to the relay works.
- **Release keystore**: backed up to the private Cloudflare R2 bucket `infinitum-key-backups`. A second copy on an Infinitum server is still wanted.
- Roadmap items (number linking phases 2 and 3, $FAB, SFU regions, and more) are listed in README.md under "Roadmap".

## Run the tests

```sh
npm ci && npm test                                                # relay, crypto, web client logic
cd app && node --test --experimental-strip-types src/core/*.test.ts   # React Native core
cd android-native && ./gradlew test assembleDebug                 # native Android
```
