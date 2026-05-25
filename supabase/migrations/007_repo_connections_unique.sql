create unique index if not exists repos_user_full_name_idx on public.repos(user_id, full_name);
create unique index if not exists repos_user_github_repo_idx on public.repos(user_id, github_repo_id);
