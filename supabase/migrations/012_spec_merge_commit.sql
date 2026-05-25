alter table public.specs
  add column if not exists merge_sha text;

create index if not exists specs_merge_sha_idx on public.specs(merge_sha);
