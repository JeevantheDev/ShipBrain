create or replace function public.shipbrain_release_trace_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  action_label text;
begin
  if new.pending_action is not null and (
    tg_op = 'INSERT'
    or coalesce(old.pending_action, '{}'::jsonb) is distinct from coalesce(new.pending_action, '{}'::jsonb)
  ) then
    action_label := coalesce(new.pending_action->>'description', new.status);
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.repo_full_name,
      'release_trace_pending',
      'Release action pending',
      coalesce(new.title, 'Release trace') || ' · ' || action_label,
      '/releases/' || new.id,
      case when new.status = 'failed' then 'warning' else 'info' end,
      jsonb_build_object('traceId', new.id, 'status', new.status, 'pendingAction', new.pending_action),
      'trace:' || new.id || ':pending:' || coalesce(new.pending_action->>'type', new.status)
    );
  end if;

  if tg_op = 'UPDATE' and coalesce(old.status, '') is distinct from coalesce(new.status, '') then
    perform public.shipbrain_upsert_notification(
      new.user_id,
      new.repo_full_name,
      'release_trace_status',
      'Release trace updated',
      coalesce(new.title, 'Release trace') || ' moved to ' || replace(new.status, '_', ' ') || '.',
      '/releases/' || new.id,
      case
        when new.status in ('production_live', 'completed') then 'success'
        when new.status = 'failed' then 'warning'
        else 'info'
      end,
      jsonb_build_object('traceId', new.id, 'oldStatus', old.status, 'newStatus', new.status),
      'trace:' || new.id || ':status:' || new.status
    );
  end if;

  return new;
end;
$$;

drop trigger if exists shipbrain_release_trace_notify_trigger on public.release_traces;
create trigger shipbrain_release_trace_notify_trigger
  after insert or update on public.release_traces
  for each row execute function public.shipbrain_release_trace_notify();
