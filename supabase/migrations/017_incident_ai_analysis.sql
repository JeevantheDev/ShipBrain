alter table public.incidents
  add column if not exists ai_analysis jsonb;
