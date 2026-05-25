alter table public.incidents
  add column if not exists hotfix_branch text,
  add column if not exists hotfix_base_branch text,
  add column if not exists hotfix_pr_number integer,
  add column if not exists hotfix_pr_url text,
  add column if not exists hotfix_pr_status text,
  add column if not exists hotfix_merge_sha text,
  add column if not exists hotfix_commits jsonb not null default '[]'::jsonb,
  add column if not exists fix_approved_at timestamptz;

alter table public.specs
  add column if not exists incident_id uuid references public.incidents(id) on delete set null;

create index if not exists incidents_hotfix_pr_idx on public.incidents(repo_full_name, hotfix_pr_number);
create index if not exists incidents_hotfix_branch_idx on public.incidents(repo_full_name, hotfix_branch);
create index if not exists specs_incident_id_idx on public.specs(incident_id);
