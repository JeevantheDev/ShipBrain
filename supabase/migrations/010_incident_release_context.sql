alter table public.incidents
  add column if not exists release_version text;

create index if not exists incidents_release_version_idx on public.incidents(release_version);
