-- AI Memory Notes: persistent key→value memory for ShipBrain AI
-- Scoped per user (and optionally per repo).
-- Upserted by the AI after significant interactions (incidents, rollbacks, etc.)

create table if not exists public.ai_memory_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  repo_full_name text,                          -- null = global across all repos
  key text not null,                            -- e.g. "last_incident_pattern", "team_convention"
  value text not null,                          -- free-form text (kept short, ~200 chars)
  category text not null default 'general'
    check (category in ('general', 'incident', 'release', 'convention', 'preference')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert by (user_id, repo_full_name, key)
create unique index if not exists ai_memory_notes_upsert_idx
  on public.ai_memory_notes(user_id, coalesce(repo_full_name, ''), key);

create index if not exists ai_memory_notes_user_repo_idx
  on public.ai_memory_notes(user_id, repo_full_name, updated_at desc);

alter table public.ai_memory_notes enable row level security;

drop policy if exists "ai memory notes own rows" on public.ai_memory_notes;
create policy "ai memory notes own rows" on public.ai_memory_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
