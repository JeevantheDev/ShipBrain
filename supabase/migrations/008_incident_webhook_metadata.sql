alter table public.incidents
  add column if not exists title text,
  add column if not exists repo_full_name text,
  add column if not exists environment text,
  add column if not exists service text,
  add column if not exists severity text,
  add column if not exists branch text,
  add column if not exists commit_sha text,
  add column if not exists external_id text,
  add column if not exists payload jsonb not null default '{}'::jsonb;

create index if not exists incidents_repo_updated_idx on public.incidents(repo_full_name, updated_at desc);
create index if not exists incidents_user_updated_idx on public.incidents(user_id, updated_at desc);
