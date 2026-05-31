-- ============================================================================
-- SHIPBRAIN DATABASE RESET SCRIPT
-- ============================================================================
-- WARNING: This script will DELETE ALL DATA including auth users!
-- Run this in Supabase SQL Editor to completely reset the database.
-- After running this, you'll need to re-apply all migrations.
-- ============================================================================

-- Step 1: Disable triggers temporarily for faster truncation
SET session_replication_role = 'replica';

-- Step 2: Truncate all ShipBrain tables (order matters due to foreign keys)
-- Child tables first, then parent tables

-- Chat & Messaging
TRUNCATE TABLE IF EXISTS public.chat_messages CASCADE;
TRUNCATE TABLE IF EXISTS public.chat_threads CASCADE;

-- Telegram
TRUNCATE TABLE IF EXISTS public.telegram_notification_deliveries CASCADE;
TRUNCATE TABLE IF EXISTS public.telegram_webhook_updates CASCADE;
TRUNCATE TABLE IF EXISTS public.telegram_users CASCADE;

-- Release & Deployment
TRUNCATE TABLE IF EXISTS public.trace_events CASCADE;
TRUNCATE TABLE IF EXISTS public.rollback_history CASCADE;
TRUNCATE TABLE IF EXISTS public.release_traces CASCADE;
TRUNCATE TABLE IF EXISTS public.cloudflare_webhook_events CASCADE;

-- Core entities
TRUNCATE TABLE IF EXISTS public.notifications CASCADE;
TRUNCATE TABLE IF EXISTS public.approval_events CASCADE;
TRUNCATE TABLE IF EXISTS public.ci_runs CASCADE;
TRUNCATE TABLE IF EXISTS public.incidents CASCADE;
TRUNCATE TABLE IF EXISTS public.spec_pr_recipes CASCADE;
TRUNCATE TABLE IF EXISTS public.specs CASCADE;
TRUNCATE TABLE IF EXISTS public.repos CASCADE;

-- User profile (must be last in public schema due to foreign keys)
TRUNCATE TABLE IF EXISTS public.profiles CASCADE;

-- Step 3: Delete all auth users (this will cascade to profiles due to FK)
DELETE FROM auth.users;

-- Step 4: Reset auth-related tables
TRUNCATE TABLE IF EXISTS auth.sessions CASCADE;
TRUNCATE TABLE IF EXISTS auth.refresh_tokens CASCADE;
TRUNCATE TABLE IF EXISTS auth.mfa_factors CASCADE;
TRUNCATE TABLE IF EXISTS auth.mfa_challenges CASCADE;
TRUNCATE TABLE IF EXISTS auth.mfa_amr_claims CASCADE;
TRUNCATE TABLE IF EXISTS auth.flow_state CASCADE;
TRUNCATE TABLE IF EXISTS auth.identities CASCADE;

-- Step 5: Re-enable triggers
SET session_replication_role = 'origin';

-- Step 6: Verify reset
SELECT 'Reset complete! Tables truncated:' AS status;
SELECT table_name,
       (SELECT COUNT(*) FROM information_schema.tables t2
        WHERE t2.table_name = t.table_name AND t2.table_schema = 'public') as exists
FROM (VALUES
  ('profiles'), ('repos'), ('specs'), ('ci_runs'), ('incidents'),
  ('approval_events'), ('notifications'), ('release_traces'), ('trace_events'),
  ('rollback_history'), ('chat_threads'), ('chat_messages'), ('telegram_users'),
  ('telegram_webhook_updates'), ('telegram_notification_deliveries'),
  ('cloudflare_webhook_events'), ('spec_pr_recipes')
) AS t(table_name);

SELECT 'Auth users remaining: ' || COUNT(*)::text AS auth_status FROM auth.users;

-- ============================================================================
-- NEXT STEPS:
-- 1. Run all migrations in order (001_initial.sql through 035_spec_pr_recipes.sql)
-- 2. Or use: npm run migrate:apply
-- ============================================================================
