alter table public.incidents
  add column if not exists pagerduty_sync_status text,
  add column if not exists pagerduty_sync_error text;

create index if not exists incidents_pagerduty_sync_status_idx on public.incidents(pagerduty_sync_status);
