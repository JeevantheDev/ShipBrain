alter table public.specs
  add column if not exists release_tag text,
  add column if not exists release_status text not null default 'not_started',
  add column if not exists merged_at timestamptz,
  add column if not exists deployed_at timestamptz;

create index if not exists specs_release_updated_idx on public.specs(release_status, updated_at desc);
create index if not exists specs_release_tag_idx on public.specs(release_tag);
