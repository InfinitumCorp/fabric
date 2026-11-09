# FABRIC landing page

Public landing page for https://infinitumfabric.app/ (also www). Static files in `public/`, served by the Worker `fabric-site` on Cloudflare (Workers Static Assets, no code).

The page says FABRIC is in development and sign-in is not open. Replace it with the app when the app is deployed to this domain.

Public access: the account-wide "All Workers" Cloudflare Access app gates every Worker. The "FABRIC (public)" Access app bypasses it for these domains.

```sh
npx wrangler deploy
```
