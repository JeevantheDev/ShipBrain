alter table public.ci_runs
  add column if not exists spec_id uuid references public.specs(id) on delete set null,
  add column if not exists pr_number integer;

alter table public.specs
  add column if not exists ci_status text,
  add column if not exists ci_conclusion text,
  add column if not exists latest_ci_run_id bigint,
  add column if not exists deployment_status text not null default 'not_requested',
  add column if not exists deployment_approved_at timestamptz,
  add column if not exists deployment_audit_id uuid references public.approval_events(id) on delete set null;

create index if not exists ci_runs_spec_updated_idx on public.ci_runs(spec_id, updated_at desc);
create index if not exists ci_runs_pr_idx on public.ci_runs(repo_full_name, pr_number, updated_at desc);
create index if not exists specs_repo_branch_idx on public.specs(repo_full_name, branch_name);
create index if not exists specs_pr_idx on public.specs(repo_full_name, pr_number);
