alter table public.specs
  add column if not exists release_sha text,
  add column if not exists deployment_run_id bigint,
  add column if not exists deployment_url text;

create index if not exists specs_release_sha_idx on public.specs(release_sha);
create index if not exists specs_deployment_run_idx on public.specs(deployment_run_id);
