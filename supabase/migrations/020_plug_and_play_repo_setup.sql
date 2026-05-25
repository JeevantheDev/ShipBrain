alter table public.repos
  add column if not exists setup_status text not null default 'not_started',
  add column if not exists setup_pr_number integer,
  add column if not exists setup_pr_url text,
  add column if not exists setup_branch text,
  add column if not exists setup_metadata jsonb not null default '{}'::jsonb,
  add column if not exists shipbrain_api_key_hash text,
  add column if not exists shipbrain_api_key_last4 text,
  add column if not exists vercel_preview_env_confirmed boolean not null default false,
  add column if not exists connected_at timestamptz;

alter table public.ci_runs
  add column if not exists environment text,
  add column if not exists preview_url text,
  add column if not exists branch_alias text;

alter table public.specs
  add column if not exists preview_url text,
  add column if not exists preview_status text,
  add column if not exists preview_branch_alias text,
  add column if not exists preview_deployed_at timestamptz;

create index if not exists repos_setup_status_idx on public.repos(user_id, setup_status);
create index if not exists repos_shipbrain_api_key_hash_idx on public.repos(shipbrain_api_key_hash) where shipbrain_api_key_hash is not null;
create index if not exists specs_preview_idx on public.specs(repo_full_name, pr_number, preview_status);
