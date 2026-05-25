alter table public.specs
  add column if not exists repo_full_name text,
  add column if not exists branch_name text,
  add column if not exists error_message text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists specs_user_updated_idx on public.specs(user_id, updated_at desc);
