alter table public.ci_runs
  add column if not exists repo_full_name text,
  add column if not exists workflow_name text,
  add column if not exists title text,
  add column if not exists html_url text,
  add column if not exists head_sha text,
  add column if not exists event text;

create index if not exists ci_runs_updated_idx on public.ci_runs(updated_at desc);
create index if not exists ci_runs_repo_updated_idx on public.ci_runs(repo_full_name, updated_at desc);
