create table if not exists public.release_traces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  repo_full_name text not null,
  type text not null default 'feature' check (type in ('feature', 'hotfix', 'release')),
  title text not null,
  description text,
  status text not null default 'draft',
  current_phase text not null default 'development',
  pending_action jsonb,
  source_branch text not null,
  target_branch text not null,
  draft_pr_number integer,
  draft_pr_url text,
  release_pr_number integer,
  release_pr_url text,
  merged_to_develop jsonb,
  merged_to_main jsonb,
  preview_deployment jsonb,
  production_deployment jsonb,
  incident_id uuid references public.incidents(id) on delete set null,
  spec_id uuid references public.specs(id) on delete set null,
  reverse_sync_pr_number integer,
  reverse_sync_pr_url text,
  reverse_sync_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint release_traces_status_check check (status in (
    'draft',
    'ready_for_review',
    'approved',
    'merged_develop',
    'preview_live',
    'release_pending',
    'merged_main',
    'production_live',
    'completed',
    'failed',
    'cancelled'
  )),
  constraint unique_trace_pr unique (repo_full_name, draft_pr_number)
);

create table if not exists public.trace_events (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references public.release_traces(id) on delete cascade,
  event_type text not null,
  actor text not null,
  actor_type text not null default 'system',
  details jsonb not null default '{}'::jsonb,
  source text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.telegram_webhook_updates (
  update_id bigint primary key,
  telegram_chat_id bigint,
  status text not null default 'processing',
  error_fingerprint text,
  error_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_traces_repo_status on public.release_traces(repo_full_name, status);
create index if not exists idx_traces_user_updated on public.release_traces(user_id, updated_at desc);
create index if not exists idx_traces_pending on public.release_traces(user_id) where pending_action is not null;
create index if not exists idx_traces_spec on public.release_traces(spec_id) where spec_id is not null;
create index if not exists idx_traces_incident on public.release_traces(incident_id) where incident_id is not null;
create index if not exists idx_trace_events_trace on public.trace_events(trace_id, created_at desc);
create index if not exists idx_telegram_updates_status on public.telegram_webhook_updates(status, updated_at desc);

alter table public.release_traces enable row level security;
alter table public.trace_events enable row level security;
alter table public.telegram_webhook_updates enable row level security;

drop policy if exists "release traces own rows" on public.release_traces;
create policy "release traces own rows" on public.release_traces
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "trace events own rows" on public.trace_events;
create policy "trace events own rows" on public.trace_events
  for all using (
    exists (
      select 1 from public.release_traces rt
      where rt.id = trace_id and rt.user_id = auth.uid()
    )
  );

drop policy if exists "telegram webhook updates service only" on public.telegram_webhook_updates;
create policy "telegram webhook updates service only" on public.telegram_webhook_updates
  for all using (false) with check (false);
