-- Add rollback support to release_traces table
alter table public.release_traces
  add column if not exists rollback_metadata jsonb,
  add column if not exists is_rollback boolean not null default false,
  add column if not exists rollback_source_tag text,
  add column if not exists rollback_target_tag text;

-- Create rollback_history table for audit trail
create table if not exists public.rollback_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  repo_full_name text not null,
  trace_id uuid references public.release_traces(id) on delete set null,
  spec_id uuid references public.specs(id) on delete set null,
  source_release_tag text not null,
  target_release_tag text not null,
  target_release_sha text not null,
  status text not null default 'pending' check (status in ('pending', 'deploying', 'deployed', 'failed', 'cancelled')),
  initiated_by text not null,
  initiated_at timestamptz not null default now(),
  completed_at timestamptz,
  workflow_url text,
  error_message text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Update status constraint to include rolling_back and rolled_back
alter table public.release_traces drop constraint if exists release_traces_status_check;
alter table public.release_traces add constraint release_traces_status_check check (status in (
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
  'cancelled',
  'rolling_back',
  'rolled_back'
));

-- Create indexes for rollback_history
create index if not exists idx_rollback_history_user on public.rollback_history(user_id, created_at desc);
create index if not exists idx_rollback_history_repo on public.rollback_history(repo_full_name, created_at desc);
create index if not exists idx_rollback_history_trace on public.rollback_history(trace_id) where trace_id is not null;
create index if not exists idx_rollback_history_status on public.rollback_history(status) where status in ('pending', 'deploying');

-- RLS for rollback_history
alter table public.rollback_history enable row level security;

drop policy if exists "rollback history own rows" on public.rollback_history;
create policy "rollback history own rows" on public.rollback_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
