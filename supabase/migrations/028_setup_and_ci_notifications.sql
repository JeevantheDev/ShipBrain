create or replace function public.shipbrain_repo_setup_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.setup_status in ('pr_opened', 'already_configured') then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.full_name,
      'repo_setup',
      case when new.setup_status = 'pr_opened' then 'Setup PR opened' else 'Repository connected' end,
      case
        when new.setup_status = 'pr_opened' then 'ShipBrain opened setup PR #' || coalesce(new.setup_pr_number::text, '') || ' for ' || new.full_name || '.'
        else 'ShipBrain connected ' || new.full_name || ' and found workflows already configured.'
      end,
      '/settings/secrets',
      'success',
      jsonb_build_object('repoId', new.id, 'repo', new.full_name, 'setupStatus', new.setup_status, 'setupPrNumber', new.setup_pr_number, 'setupPrUrl', new.setup_pr_url),
      'repo:' || new.id || ':setup:' || new.setup_status
    );
  end if;

  if tg_op = 'UPDATE'
    and coalesce(old.setup_status, '') is distinct from coalesce(new.setup_status, '')
    and new.setup_status in ('merged', 'closed', 'already_configured')
  then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.full_name,
      'repo_setup',
      case
        when new.setup_status = 'merged' then 'Setup PR merged'
        when new.setup_status = 'closed' then 'Setup PR closed'
        else 'Repository configured'
      end,
      'Setup status for ' || new.full_name || ' is now ' || replace(new.setup_status, '_', ' ') || '.',
      '/settings/secrets',
      case when new.setup_status = 'closed' then 'warning' else 'success' end,
      jsonb_build_object('repoId', new.id, 'repo', new.full_name, 'setupStatus', new.setup_status, 'setupPrNumber', new.setup_pr_number, 'setupPrUrl', new.setup_pr_url),
      'repo:' || new.id || ':setup:' || new.setup_status
    );
  end if;

  return new;
end;
$$;

drop trigger if exists shipbrain_repo_setup_notify_trigger on public.repos;
create trigger shipbrain_repo_setup_notify_trigger
  after insert or update on public.repos
  for each row execute function public.shipbrain_repo_setup_notify();

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
    jsonb_build_object('ciRunId', new.id, 'githubRunId', new.github_run_id, 'repo', new.repo_full_name, 'branch', new.branch, 'runUrl', new.run_url),
    'ci:' || new.id || ':failure'
  );

  return new;
end;
$$;

drop trigger if exists shipbrain_ci_runs_notify_trigger on public.ci_runs;
create trigger shipbrain_ci_runs_notify_trigger
  after insert or update on public.ci_runs
  for each row execute function public.shipbrain_ci_runs_notify();
