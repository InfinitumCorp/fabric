// fabric-store: snapshot storage for FabriC++ relays.
// Callers present x-fabric-key; its SHA-256 must be listed in fabric.gateway_keys.
// Snapshots arrive already sealed (AES-256-GCM) by the relay, so this function and Supabase
// only ever hold ciphertext. Uses the project's service-role credentials, which never leave Supabase.
//
//   GET  ?name=relay   -> the latest snapshot (404 if none)
//   PUT  ?name=relay   -> replace it (body: application/octet-stream, at most 50 MB)

import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY")!;
const BUCKET = "fabric-relay";
const MAX_BYTES = 50 * 1024 * 1024;
const NAME = /^[a-z0-9-]{1,40}$/;

const auth = {
  apikey: SERVICE_KEY,
  ...(SERVICE_KEY.startsWith("eyJ") ? { authorization: `Bearer ${SERVICE_KEY}` } : {}),
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const validKeys = new Map<string, number>(); // hash -> checked at (ms)
async function authorized(key: string | null) {
  if (!key || key.length < 32) return false;
  const hash = await sha256Hex(key);
  const seen = validKeys.get(hash);
  if (seen && Date.now() - seen < 60_000) return true;
  // fabric.* is not exposed over REST, so read it over the function's own database connection
  const rows = await sql`select 1 from fabric.gateway_keys where key_hash = ${hash}`;
  if (rows.length) validKeys.set(hash, Date.now());
  return rows.length > 0;
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req.headers.get("x-fabric-key")))) return json({ error: "unauthorized" }, 401);
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!NAME.test(name)) return json({ error: "bad name" }, 400);
  const object = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${name}.bin`;
  try {
    if (req.method === "GET") {
      const res = await fetch(object, { headers: auth });
      if (res.status === 400 || res.status === 404) return json({ error: "not found" }, 404);
      if (!res.ok) return json({ error: `storage ${res.status}` }, 502);
      return new Response(res.body, { headers: { "content-type": "application/octet-stream" } });
    }
    if (req.method === "PUT") {
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.length < 32 || body.length > MAX_BYTES) return json({ error: "bad size" }, 413);
      if (new TextDecoder().decode(body.subarray(0, 4)) !== "FBK1") return json({ error: "not a sealed snapshot" }, 400);
      const res = await fetch(object, {
        method: "POST",
        headers: { ...auth, "content-type": "application/octet-stream", "x-upsert": "true" },
        body,
      });
      if (!res.ok) {
        console.error("upload failed", res.status, (await res.text()).slice(0, 300));
        return json({ error: "upload failed" }, 502);
      }
      return json({ ok: true, bytes: body.length });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    console.error(err);
    return json({ error: "store error" }, 500);
  }
});
