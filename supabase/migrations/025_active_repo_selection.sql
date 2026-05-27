alter table public.profiles
  add column if not exists active_repo_full_name text;
