alter table public.specs
  add column if not exists release_pr_number integer,
  add column if not exists release_pr_url text,
  add column if not exists release_pr_status text;

create index if not exists specs_release_pr_idx on public.specs(repo_full_name, release_pr_number);
