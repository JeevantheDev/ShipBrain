alter table public.repos
  add column if not exists telegram_notifications_enabled boolean not null default false;

create table if not exists public.telegram_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  telegram_chat_id bigint unique not null,
  telegram_username text,
  verified boolean not null default false,
  verification_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_users_chat_id_idx on public.telegram_users(telegram_chat_id);
create index if not exists telegram_users_user_id_idx on public.telegram_users(user_id);
create unique index if not exists telegram_users_code_idx on public.telegram_users(verification_code)
  where verification_code is not null;

alter table public.telegram_users enable row level security;
drop policy if exists "telegram users own rows" on public.telegram_users;
create policy "telegram users own rows" on public.telegram_users
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.telegram_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  telegram_user_id uuid not null references public.telegram_users(id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(notification_id, telegram_user_id)
);

create index if not exists telegram_deliveries_pending_idx
  on public.telegram_notification_deliveries(status, created_at)
  where status = 'pending';

alter table public.telegram_notification_deliveries enable row level security;
drop policy if exists "telegram deliveries own rows" on public.telegram_notification_deliveries;
create policy "telegram deliveries own rows" on public.telegram_notification_deliveries
  for select using (
    exists (
      select 1
      from public.telegram_users tu
      where tu.id = telegram_user_id
        and tu.user_id = auth.uid()
    )
  );

create or replace function public.shipbrain_enqueue_telegram_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.telegram_notification_deliveries(notification_id, telegram_user_id)
  select new.id, tu.id
  from public.telegram_users tu
  where tu.user_id = new.user_id
    and tu.verified = true
    and (
      new.repo_full_name is null
      or exists (
        select 1
        from public.repos r
        where r.user_id = new.user_id
          and r.full_name = new.repo_full_name
          and r.telegram_notifications_enabled = true
      )
    )
  on conflict (notification_id, telegram_user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists shipbrain_notifications_telegram_trigger on public.notifications;
create trigger shipbrain_notifications_telegram_trigger
  after insert on public.notifications
  for each row execute function public.shipbrain_enqueue_telegram_notification();
