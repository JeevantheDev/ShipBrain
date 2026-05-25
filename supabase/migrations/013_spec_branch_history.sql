alter table public.specs
  add column if not exists feature_head_sha text,
  add column if not exists feature_last_synced_at timestamptz;

create index if not exists specs_feature_head_sha_idx on public.specs(feature_head_sha);
