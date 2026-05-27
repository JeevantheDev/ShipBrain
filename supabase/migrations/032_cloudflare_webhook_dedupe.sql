create table if not exists public.cloudflare_webhook_events (
  event_id text primary key,
  repo_full_name text,
  status text not null default 'processing',
  payload_hash text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cloudflare_webhook_events_repo_idx
  on public.cloudflare_webhook_events(repo_full_name, created_at desc);

alter table public.cloudflare_webhook_events enable row level security;

drop policy if exists "cloudflare webhook events service only" on public.cloudflare_webhook_events;
create policy "cloudflare webhook events service only" on public.cloudflare_webhook_events
  for all using (false) with check (false);
