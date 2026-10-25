-- Supabase schema for the LaundryAI fallback (free tier).
-- Run this once in the NEW project's SQL editor, then create one PRIVATE
-- storage bucket (dashboard -> Storage -> Create bucket, e.g. "laundryai")
-- and set SUPABASE_BUCKET to that name. The backend uses the SERVICE ROLE
-- key, which bypasses RLS, so keep RLS enabled with NO public policies:
-- the anon key must never read anyone's predictions or photos. Images are
-- served through the backend after an owner check, never via public URLs.

create table if not exists predictions (
  id text primary key,
  owner_uid text not null,
  created_at text not null,
  data jsonb not null
);
create index if not exists predictions_owner_idx
  on predictions (owner_uid, created_at desc);

create table if not exists feedback (
  id text primary key,
  owner_uid text not null,
  review_status text not null,
  created_at text not null,
  data jsonb not null
);
create index if not exists feedback_status_idx
  on feedback (review_status, created_at desc);

create table if not exists audit_events (
  id text primary key,
  created_at text not null,
  data jsonb not null
);

alter table predictions enable row level security;
alter table feedback enable row level security;
alter table audit_events enable row level security;
-- Intentionally no policies: only the service-role key (backend) may
-- access these tables.
