-- Migration: Incident reverse sync tracking
-- Adds columns to track reverse sync PRs from main → develop after hotfix merge

alter table public.incidents
  add column if not exists reverse_sync_pr_number integer,
  add column if not exists reverse_sync_pr_url text,
  add column if not exists reverse_sync_pr_status text,
  add column if not exists reverse_sync_branch text,
  add column if not exists reverse_sync_created_at timestamptz,
  add column if not exists reverse_sync_merged_at timestamptz,
  add column if not exists reverse_sync_error text;

-- Index for efficient reverse sync PR lookups
create index if not exists incidents_reverse_sync_pr_idx
  on public.incidents(repo_full_name, reverse_sync_pr_number);

-- Add audit event for incident fix to the approval_events table
-- This allows tracking incident-specific approvals alongside CI run approvals
comment on column public.incidents.reverse_sync_pr_number is 'PR number for the reverse sync from main to develop after a hotfix is merged to production';
comment on column public.incidents.reverse_sync_pr_status is 'Status of reverse sync: pending, open, merged, failed';
