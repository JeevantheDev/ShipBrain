-- ShipBrain Database Reset Script
-- This clears all operational data while preserving user accounts and repo connections
-- Run this in Supabase SQL Editor

-- Disable triggers temporarily for faster deletion
SET session_replication_role = replica;

-- Clear rollback history
TRUNCATE TABLE public.rollback_history CASCADE;

-- Clear release traces and events
TRUNCATE TABLE public.trace_events CASCADE;
TRUNCATE TABLE public.release_traces CASCADE;

-- Clear chat data
TRUNCATE TABLE public.chat_messages CASCADE;
TRUNCATE TABLE public.chat_threads CASCADE;

-- Clear notifications
TRUNCATE TABLE public.telegram_notification_deliveries CASCADE;
TRUNCATE TABLE public.notifications CASCADE;

-- Clear CI runs
TRUNCATE TABLE public.ci_runs CASCADE;

-- Clear specs (this is the main operational data)
TRUNCATE TABLE public.specs CASCADE;

-- Clear incidents
TRUNCATE TABLE public.incidents CASCADE;

-- Clear approval events
TRUNCATE TABLE public.approval_events CASCADE;

-- Clear webhook deduplication tables
TRUNCATE TABLE public.cloudflare_webhook_events CASCADE;
TRUNCATE TABLE public.telegram_webhook_updates CASCADE;

-- Clear spec recipes (templates) - optional, uncomment if needed
-- TRUNCATE TABLE public.spec_pr_recipes CASCADE;

-- Re-enable triggers
SET session_replication_role = DEFAULT;

-- Verify cleanup
SELECT 'specs' as table_name, COUNT(*) as count FROM public.specs
UNION ALL SELECT 'ci_runs', COUNT(*) FROM public.ci_runs
UNION ALL SELECT 'release_traces', COUNT(*) FROM public.release_traces
UNION ALL SELECT 'incidents', COUNT(*) FROM public.incidents
UNION ALL SELECT 'notifications', COUNT(*) FROM public.notifications
UNION ALL SELECT 'approval_events', COUNT(*) FROM public.approval_events;
