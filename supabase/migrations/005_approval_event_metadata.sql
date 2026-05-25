alter table public.approval_events
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists approval_events_entity_idx on public.approval_events(entity_type, entity_id, created_at desc);
create index if not exists approval_events_actor_idx on public.approval_events(actor_id, created_at desc);
