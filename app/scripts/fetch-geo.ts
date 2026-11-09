// Download the pinned v2fly geoip.dat and dlc.dat (saved as geosite.dat).
// Fails closed when the publisher .sha256sum asset or the file bytes disagree with app/geo.lock.json.

import { main } from "../src/core/geoFetch.ts";

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
