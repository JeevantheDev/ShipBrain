alter table public.incidents
  add column if not exists dedupe_key text;

create unique index if not exists incidents_user_dedupe_key_idx
  on public.incidents(user_id, dedupe_key)
  where dedupe_key is not null;
