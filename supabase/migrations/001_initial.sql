create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  github_login text,
  github_access_token text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.repos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  github_repo_id bigint not null,
  full_name text not null,
  default_branch text not null default 'main',
  created_at timestamptz not null default now()
);

create table if not exists public.specs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  repo_id uuid references public.repos(id) on delete set null,
  raw_spec text not null,
  decomposed_tasks jsonb,
  scaffold_code jsonb,
  pr_number integer,
  pr_url text,
  status text not null default 'draft',
  created_at timestamptz not null default now()
);

create table if not exists public.ci_runs (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid references public.repos(id) on delete set null,
  github_run_id bigint unique not null,
  branch text,
  status text not null,
  conclusion text,
  ai_explanation text,
  ai_fix_suggestion text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  alert_source text not null default 'manual',
  status text not null default 'open',
  raw_logs text not null,
  root_cause text,
  ai_fix_proposal text,
  postmortem_draft text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.approval_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  action text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.repos enable row level security;
alter table public.specs enable row level security;
alter table public.ci_runs enable row level security;
alter table public.incidents enable row level security;
alter table public.approval_events enable row level security;

drop policy if exists "profiles own rows" on public.profiles;
drop policy if exists "repos own rows" on public.repos;
drop policy if exists "specs own rows" on public.specs;
drop policy if exists "incidents own rows" on public.incidents;
drop policy if exists "approval own rows" on public.approval_events;
drop policy if exists "ci runs readable" on public.ci_runs;

create policy "profiles own rows" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "repos own rows" on public.repos for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "specs own rows" on public.specs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "incidents own rows" on public.incidents for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "approval own rows" on public.approval_events for all using (auth.uid() = actor_id) with check (auth.uid() = actor_id);
create policy "ci runs readable" on public.ci_runs for select using (true);

alter publication supabase_realtime add table public.ci_runs;
alter publication supabase_realtime add table public.incidents;
