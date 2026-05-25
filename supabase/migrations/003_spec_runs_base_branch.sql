alter table public.specs
  add column if not exists base_branch text not null default 'main';
