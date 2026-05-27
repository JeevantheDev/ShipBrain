create or replace function public.shipbrain_ci_runs_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
begin
  if coalesce(new.conclusion, new.status, '') not in ('failure', 'cancelled', 'timed_out', 'failed') then
    return new;
  end if;

  select r.user_id into owner_id
  from public.repos r
  where r.full_name = new.repo_full_name
  limit 1;

  perform public.shipbrain_upsert_notification(
    owner_id,
    new.repo_full_name,
    'ci_failure',
    'Workflow needs attention',
    coalesce(new.title, 'GitHub workflow') || ' reported ' || coalesce(new.conclusion, new.status, 'failure') || ' on ' || coalesce(new.branch, 'branch') || '.',
    '/ci',
    'warning',
    jsonb_build_object('ciRunId', new.id, 'githubRunId', new.github_run_id, 'repo', new.repo_full_name, 'branch', new.branch, 'runUrl', new.html_url),
    'ci:' || new.id || ':failure'
  );

  return new;
end;
$$;
