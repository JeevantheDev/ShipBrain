create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  repo_full_name text,
  type text not null,
  title text not null,
  body text not null default '',
  href text not null default '/dashboard',
  severity text not null default 'info',
  metadata jsonb not null default '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists notifications_user_dedupe_idx
  on public.notifications(user_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);

create index if not exists notifications_user_unread_idx
  on public.notifications(user_id, created_at desc)
  where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists "notifications own rows" on public.notifications;
create policy "notifications own rows" on public.notifications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.shipbrain_upsert_notification(
  p_user_id uuid,
  p_repo_full_name text,
  p_type text,
  p_title text,
  p_body text,
  p_href text,
  p_severity text,
  p_metadata jsonb,
  p_dedupe_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    return;
  end if;

  insert into public.notifications (
    user_id,
    repo_full_name,
    type,
    title,
    body,
    href,
    severity,
    metadata,
    dedupe_key
  )
  values (
    p_user_id,
    p_repo_full_name,
    p_type,
    p_title,
    coalesce(p_body, ''),
    coalesce(p_href, '/dashboard'),
    coalesce(p_severity, 'info'),
    coalesce(p_metadata, '{}'::jsonb),
    p_dedupe_key
  )
  on conflict (user_id, dedupe_key)
  where dedupe_key is not null
  do update set
    repo_full_name = excluded.repo_full_name,
    type = excluded.type,
    title = excluded.title,
    body = excluded.body,
    href = excluded.href,
    severity = excluded.severity,
    metadata = excluded.metadata,
    read_at = null,
    created_at = now();
end;
$$;

create or replace function public.shipbrain_specs_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pr_label text;
  branch_label text;
begin
  pr_label := case when new.pr_number is not null then 'PR #' || new.pr_number else 'Draft PR' end;
  branch_label := coalesce(new.branch_name, 'feature branch') || ' -> ' || coalesce(new.base_branch, 'target branch');

  if (tg_op = 'INSERT' or (tg_op = 'UPDATE' and coalesce(old.status, '') is distinct from coalesce(new.status, '')))
    and new.status = 'merged'
  then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.repo_full_name,
      'draft_pr_merged',
      'Draft PR merged',
      pr_label || ' was merged for ' || branch_label || '.',
      '/spec-to-pr',
      'success',
      jsonb_build_object('specId', new.id, 'prNumber', new.pr_number, 'prUrl', new.pr_url, 'branch', new.branch_name, 'baseBranch', new.base_branch),
      'spec:' || new.id || ':draft_pr_merged'
    );
  end if;

  if (tg_op = 'INSERT' or (tg_op = 'UPDATE' and coalesce(old.preview_status, '') is distinct from coalesce(new.preview_status, '')))
    and new.preview_status = 'deployed'
  then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.repo_full_name,
      'release',
      'Preview release deployed',
      coalesce(new.repo_full_name, 'Repository') || ' preview is live for ' || coalesce(new.branch_name, 'develop') || '.',
      '/ci',
      'success',
      jsonb_build_object('specId', new.id, 'environment', 'preview', 'previewUrl', new.preview_url, 'branchAlias', new.preview_branch_alias, 'prNumber', new.pr_number),
      'spec:' || new.id || ':preview_deployed'
    );
  end if;

  if (tg_op = 'INSERT' or (tg_op = 'UPDATE' and coalesce(old.release_status, '') is distinct from coalesce(new.release_status, '')))
    and new.release_status = 'deployed'
  then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.repo_full_name,
      'release',
      'Production release deployed',
      coalesce(new.release_tag, 'Production release') || ' is live for ' || coalesce(new.repo_full_name, 'repository') || '.',
      '/ci',
      'success',
      jsonb_build_object('specId', new.id, 'environment', 'production', 'releaseTag', new.release_tag, 'releaseSha', new.release_sha, 'productionUrl', new.production_url),
      'spec:' || new.id || ':production_deployed'
    );
  end if;

  return new;
end;
$$;

create or replace function public.shipbrain_incidents_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.repo_full_name,
      'incident',
      'Incident opened',
      coalesce(new.title, 'Incident reported') || ' · ' || coalesce(new.service, new.alert_source, 'service') || ' · ' || coalesce(new.severity, 'severity pending'),
      '/incidents',
      case when coalesce(new.severity, '') in ('critical', 'error') then 'critical' else 'warning' end,
      jsonb_build_object('incidentId', new.id, 'status', new.status, 'severity', new.severity, 'service', new.service, 'releaseVersion', new.release_version),
      'incident:' || new.id || ':opened'
    );
  elsif coalesce(old.status, '') is distinct from coalesce(new.status, '') and new.status = 'resolved' then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.repo_full_name,
      'incident_resolved',
      'Incident resolved',
      coalesce(new.title, 'Incident') || ' was resolved.',
      '/incidents',
      'success',
      jsonb_build_object('incidentId', new.id, 'status', new.status, 'resolutionNote', new.resolution_note),
      'incident:' || new.id || ':resolved'
    );
  end if;

  return new;
end;
$$;

create or replace function public.shipbrain_repos_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
    and coalesce(old.setup_metadata->>'secretsUpdatedAt', '') is distinct from coalesce(new.setup_metadata->>'secretsUpdatedAt', '')
    and coalesce(new.setup_metadata->>'secretsUpdatedAt', '') <> ''
  then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.full_name,
      'secret',
      'Repository secrets updated',
      'Secrets were updated for ' || new.full_name || '.',
      '/settings/secrets',
      'info',
      jsonb_build_object('repoId', new.id, 'repo', new.full_name, 'updatedAt', new.setup_metadata->>'secretsUpdatedAt'),
      'repo:' || new.id || ':secrets:' || (new.setup_metadata->>'secretsUpdatedAt')
    );
  end if;

  if tg_op = 'UPDATE'
    and coalesce(old.setup_metadata->>'rotatedAt', '') is distinct from coalesce(new.setup_metadata->>'rotatedAt', '')
    and coalesce(new.setup_metadata->>'rotatedAt', '') <> ''
  then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.full_name,
      'secret',
      'ShipBrain API key rotated',
      'A new ShipBrain API key was generated and synced for ' || new.full_name || '.',
      '/settings/secrets',
      'success',
      jsonb_build_object('repoId', new.id, 'repo', new.full_name, 'rotatedAt', new.setup_metadata->>'rotatedAt'),
      'repo:' || new.id || ':api_key_rotated:' || (new.setup_metadata->>'rotatedAt')
    );
  end if;

  if tg_op = 'UPDATE'
    and coalesce(old.setup_metadata->>'syncedAt', '') is distinct from coalesce(new.setup_metadata->>'syncedAt', '')
    and coalesce(new.setup_metadata->>'syncedAt', '') <> ''
  then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.full_name,
      'secret',
      'ShipBrain secrets synced',
      'ShipBrain API secrets were synced to GitHub for ' || new.full_name || '.',
      '/settings/secrets',
      'success',
      jsonb_build_object('repoId', new.id, 'repo', new.full_name, 'syncedAt', new.setup_metadata->>'syncedAt'),
      'repo:' || new.id || ':secrets_synced:' || (new.setup_metadata->>'syncedAt')
    );
  end if;

  return new;
end;
$$;

create or replace function public.shipbrain_approval_events_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.action = 'env_vars_updated' then
    perform public.shipbrain_upsert_notification(
      new.actor_id,
      new.metadata->>'repo',
      'secret',
      'Environment variables updated',
      'Updated ' || coalesce(new.metadata->>'environment', 'project') || ' variables for ' || coalesce(new.metadata->>'repo', 'repository') || '.',
      '/settings/secrets',
      'info',
      jsonb_build_object('approvalEventId', new.id, 'metadata', new.metadata),
      'approval:' || new.id || ':env_vars_updated'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists shipbrain_specs_notify_trigger on public.specs;
create trigger shipbrain_specs_notify_trigger
  after insert or update on public.specs
  for each row execute function public.shipbrain_specs_notify();

drop trigger if exists shipbrain_incidents_notify_trigger on public.incidents;
create trigger shipbrain_incidents_notify_trigger
  after insert or update on public.incidents
  for each row execute function public.shipbrain_incidents_notify();

drop trigger if exists shipbrain_repos_notify_trigger on public.repos;
create trigger shipbrain_repos_notify_trigger
  after update on public.repos
  for each row execute function public.shipbrain_repos_notify();

drop trigger if exists shipbrain_approval_events_notify_trigger on public.approval_events;
create trigger shipbrain_approval_events_notify_trigger
  after insert on public.approval_events
  for each row execute function public.shipbrain_approval_events_notify();

alter publication supabase_realtime add table public.notifications;
