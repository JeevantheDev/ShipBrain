-- Add current_version column to repos table for simplified version tracking
-- This column is updated ONLY on:
--   1. Successful release deployment
--   2. Successful hotfix deployment
--   3. Successful rollback deployment

alter table public.repos
  add column if not exists current_version text,
  add column if not exists current_version_sha text,
  add column if not exists current_version_deployed_at timestamptz,
  add column if not exists current_version_type text check (current_version_type in ('release', 'hotfix', 'rollback'));

-- Create index for efficient lookups
create index if not exists repos_current_version_idx on public.repos(full_name) where current_version is not null;

-- Add comment for documentation
comment on column public.repos.current_version is 'Current production version tag (e.g., v1.0.0, hotfix-v1.0.3). Updated only on successful production deployments or rollbacks.';
comment on column public.repos.current_version_sha is 'Git SHA of the current production version.';
comment on column public.repos.current_version_deployed_at is 'Timestamp when current version was deployed to production.';
comment on column public.repos.current_version_type is 'Type of deployment: release, hotfix, or rollback.';
