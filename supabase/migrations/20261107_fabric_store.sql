-- FabriC++ relay snapshots (see supabase/functions/fabric-store and server/backup.js).
-- Everything FabriC++ keeps in the shared project lives in the `fabric` schema, RLS on every table.
-- The schema is not exposed through the REST API and the tables have no policies: only the
-- fabric-store edge function reads them, over its direct database connection.

create schema if not exists fabric;
revoke all on schema fabric from anon, authenticated;

create table if not exists fabric.gateway_keys (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  label text not null default '',
  created_at timestamptz not null default now()
);
alter table fabric.gateway_keys enable row level security;
revoke all on fabric.gateway_keys from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fabric-relay', 'fabric-relay', false, 52428800, array['application/octet-stream'])
on conflict (id) do nothing;

-- Register a relay: insert the SHA-256 (hex) of its FABRIC_SUPABASE_KEY, e.g.
--   insert into fabric.gateway_keys (key_hash, label) values ('<sha256 hex>', 'relay.infinitumfabric.app');
