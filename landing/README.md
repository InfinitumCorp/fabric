# FABRIC landing page

Public landing page for https://infinitumfabric.app/ (also www). Static files in `public/`, served by the Worker `fabric-site` on Cloudflare (Workers Static Assets, no code).

The page says FABRIC is in development and sign-in is not open. Replace it with the app when the app is deployed to this domain.

Public access: the account-wide "All Workers" Cloudflare Access app gates every Worker. The "FABRIC (public)" Access app bypasses it for these domains.

```sh
npx wrangler deploy
```

## Cumulus ID

- Header: the Cumulus://ID account bar, `cumulus-bar.js` (a copy of `https://id.cumuluscloud.app/id/bar.js`; client `fabric`, `data-issuer` for a mirror), on every page with a header. Signed out it shows **Sign in** and **Create a Cumulus://ID**; signed in, the account menu and product launcher.
- `/cid/return` (Android app) and `/cid/rn` (React Native app): the IdP's redirect for the apps; they hand `code`/`state` to the app's scheme.
- `/.well-known/assetlinks.json`: verifies the Android App Link for `app.infinitumfabric.client` (release key SHA-256). After deploy, check it is served as JSON at `https://infinitumfabric.app/.well-known/assetlinks.json`.
