# ShipBrain Release Trace Orchestrator Plan

## Vision

A **single source of truth** for all release activity in ShipBrain. The Release Trace Orchestrator tracks every merge, deployment, and hotfix across all branches—independent of GitHub Actions workflows. Users see a clear, real-time view of "what's happening" and "what needs attention" in one place.

---

## Problem Statement

Currently:
- Release state is scattered across PRs, CI runs, deployments, and incidents
- Users must check multiple places to understand current status
- Workflow failures can leave state inconsistent
- No unified timeline of what happened and what's pending

**Solution**: A centralized orchestrator that:
1. Tracks all state changes via webhooks (not dependent on workflows)
2. Maintains a single timeline of events
3. Shows clear "pending actions" for users
4. Powers both dashboard UI and Telegram bot with same data

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         RELEASE TRACE ORCHESTRATOR                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌────────────┐  │
│   │   GitHub    │    │  Cloudflare │    │   Manual    │    │  Telegram  │  │
│   │  Webhooks   │    │  Webhooks   │    │   Actions   │    │    Bot     │  │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └─────┬──────┘  │
│          │                  │                  │                  │         │
│          ▼                  ▼                  ▼                  ▼         │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                      EVENT PROCESSOR                                │  │
│   │  - Normalizes events from all sources                               │  │
│   │  - Updates release trace state                                      │  │
│   │  - Triggers notifications                                           │  │
│   │  - Determines pending actions                                       │  │
│   └───────────────────────────┬─────────────────────────────────────────┘  │
│                               │                                             │
│                               ▼                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                      RELEASE TRACE STATE                            │  │
│   │                                                                     │  │
│   │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │  │
│   │  │  Draft  │─▶│ Review  │─▶│ Merged  │─▶│ Deploy  │─▶│  Live   │   │  │
│   │  │   PR    │  │ Pending │  │   to    │  │ Pending │  │   in    │   │  │
│   │  │         │  │         │  │ develop │  │         │  │  Prod   │   │  │
│   │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘   │  │
│   │                                                                     │  │
│   │  ┌─────────────────────────────────────────────────────────────┐   │  │
│   │  │                    HOTFIX TRACK                              │   │  │
│   │  │  Incident → Hotfix PR → Merged to Main → Reverse Sync       │   │  │
│   │  └─────────────────────────────────────────────────────────────┘   │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                               │                                             │
│                               ▼                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                      OUTPUT LAYER                                   │  │
│   │                                                                     │  │
│   │  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │  │
│   │  │  Dashboard  │    │  Telegram   │    │  API for External       │ │  │
│   │  │    UI       │    │    Bot      │    │  Integrations           │ │  │
│   │  └─────────────┘    └─────────────┘    └─────────────────────────┘ │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### 1. Release Trace

A **Release Trace** is a single unit tracking code from creation to production:

```typescript
interface ReleaseTrace {
  id: string;
  repo: string;

  // Identity
  type: 'feature' | 'hotfix' | 'release';
  title: string;
  description?: string;

  // Current State
  status: ReleaseStatus;
  currentPhase: Phase;
  pendingAction?: PendingAction;

  // Branch Info
  sourceBranch: string;      // feature/xxx or hotfix/xxx
  targetBranch: string;      // develop or main

  // PR Tracking
  draftPrNumber?: number;
  draftPrUrl?: string;
  releasePrNumber?: number;
  releasePrUrl?: string;

  // Merge Info
  mergedToDevelop?: MergeInfo;
  mergedToMain?: MergeInfo;

  // Deployment Info
  previewDeployment?: DeploymentInfo;
  productionDeployment?: DeploymentInfo;

  // For Hotfixes
  incidentId?: string;
  reverseSyncPrNumber?: number;
  reverseSyncStatus?: 'pending' | 'merged' | 'conflict';

  // Timeline
  events: TraceEvent[];

  // Timestamps
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

### 2. Release Status

```typescript
type ReleaseStatus =
  | 'draft'              // PR created, work in progress
  | 'ready_for_review'   // PR ready, awaiting review
  | 'approved'           // PR approved, ready to merge
  | 'merged_develop'     // Merged to develop, preview deploying
  | 'preview_live'       // Preview deployment successful
  | 'release_pending'    // Awaiting release PR approval
  | 'merged_main'        // Merged to main, production deploying
  | 'production_live'    // Production deployment successful
  | 'completed'          // Fully deployed, no pending actions
  | 'failed'             // Something went wrong
  | 'cancelled';         // Abandoned
```

### 3. Pending Actions

Clear, actionable items for users:

```typescript
type PendingAction = {
  type:
    | 'review_pr'           // PR needs code review
    | 'approve_pr'          // PR needs approval
    | 'merge_to_develop'    // Ready to merge to develop
    | 'verify_preview'      // Preview deployed, needs verification
    | 'create_release_pr'   // Create PR from develop to main
    | 'approve_release'     // Release PR needs approval
    | 'merge_to_main'       // Ready to merge to main
    | 'verify_production'   // Production deployed, needs verification
    | 'merge_reverse_sync'  // Hotfix reverse sync needs merge
    | 'resolve_conflict';   // Manual conflict resolution needed

  description: string;
  actor?: string;          // Who should take action
  deadline?: string;       // Optional SLA
  blockedBy?: string[];    // What's preventing progress
};
```

### 4. Trace Events

Every state change is recorded:

```typescript
interface TraceEvent {
  id: string;
  timestamp: string;
  type: EventType;
  actor: string;           // User, bot, or system
  details: Record<string, any>;
  source: 'github' | 'cloudflare' | 'manual' | 'telegram' | 'system';
}

type EventType =
  | 'trace_created'
  | 'pr_opened'
  | 'pr_updated'
  | 'review_requested'
  | 'review_submitted'
  | 'pr_approved'
  | 'pr_merged'
  | 'deployment_started'
  | 'deployment_succeeded'
  | 'deployment_failed'
  | 'release_pr_created'
  | 'hotfix_created'
  | 'reverse_sync_created'
  | 'reverse_sync_merged'
  | 'incident_linked'
  | 'manual_action'
  | 'status_changed';
```

---

## Database Schema

### New Tables

```sql
-- Main release trace table
CREATE TABLE release_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,

  -- Identity
  type TEXT NOT NULL CHECK (type IN ('feature', 'hotfix', 'release')),
  title TEXT NOT NULL,
  description TEXT,

  -- State
  status TEXT NOT NULL DEFAULT 'draft',
  current_phase TEXT NOT NULL DEFAULT 'development',
  pending_action JSONB,

  -- Branch tracking
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,

  -- PR references
  draft_pr_number INTEGER,
  draft_pr_url TEXT,
  release_pr_number INTEGER,
  release_pr_url TEXT,

  -- Merge info
  merged_to_develop JSONB,    -- { sha, timestamp, actor }
  merged_to_main JSONB,

  -- Deployment info
  preview_deployment JSONB,   -- { url, status, timestamp }
  production_deployment JSONB,

  -- Hotfix specific
  incident_id UUID REFERENCES incidents(id),
  reverse_sync_pr_number INTEGER,
  reverse_sync_pr_url TEXT,
  reverse_sync_status TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Indexes
  CONSTRAINT unique_trace_pr UNIQUE (repo_full_name, draft_pr_number)
);

-- Event timeline
CREATE TABLE trace_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID REFERENCES release_traces(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT DEFAULT 'user', -- user, bot, system, github

  details JSONB DEFAULT '{}',
  source TEXT NOT NULL, -- github, cloudflare, manual, telegram, system

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_traces_repo_status ON release_traces(repo_full_name, status);
CREATE INDEX idx_traces_user_updated ON release_traces(user_id, updated_at DESC);
CREATE INDEX idx_traces_pending ON release_traces(user_id) WHERE pending_action IS NOT NULL;
CREATE INDEX idx_trace_events_trace ON trace_events(trace_id, created_at DESC);

-- RLS
ALTER TABLE release_traces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own traces" ON release_traces
  FOR ALL USING (auth.uid() = user_id);

ALTER TABLE trace_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own trace events" ON trace_events
  FOR ALL USING (
    trace_id IN (SELECT id FROM release_traces WHERE user_id = auth.uid())
  );
```

---

## Event Sources (Webhook-Based)

### 1. GitHub Webhooks

Register these GitHub webhook events:

| Event | Triggers |
|-------|----------|
| `pull_request.opened` | Create new trace or update existing |
| `pull_request.closed` | Update merge status if merged |
| `pull_request.synchronize` | Update trace with new commits |
| `pull_request_review.submitted` | Track review status |
| `push` | Detect direct pushes to develop/main |
| `check_run.completed` | Track CI status |

**Webhook Endpoint**: `/api/webhooks/github/events`

### 2. Cloudflare Webhooks (Deploy Hooks)

| Event | Triggers |
|-------|----------|
| `deployment.created` | Deployment started |
| `deployment.success` | Deployment live |
| `deployment.failed` | Deployment failed |

**Webhook Endpoint**: `/api/webhooks/cloudflare/deploy`

### 3. Manual Actions (Dashboard/Telegram)

| Action | Updates |
|--------|---------|
| Create release PR | Creates trace event, updates status |
| Approve release | Updates pending action |
| Mark as verified | Moves to next phase |
| Cancel release | Sets status to cancelled |

---

## State Machine

```
                                    ┌─────────────────┐
                                    │   PR Created    │
                                    │    (draft)      │
                                    └────────┬────────┘
                                             │
                              PR marked ready for review
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │ Ready for Review│
                              ┌─────│  (in_review)    │─────┐
                              │     └────────┬────────┘     │
                              │              │              │
                         Changes         Approved       Rejected
                         Requested           │              │
                              │              ▼              ▼
                              │     ┌─────────────────┐   ┌──────┐
                              └────▶│    Approved     │   │Closed│
                                    │   (approved)    │   └──────┘
                                    └────────┬────────┘
                                             │
                                    Merge to develop
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │Merged to Develop│
                                    │(merged_develop) │
                                    └────────┬────────┘
                                             │
                              Preview deployment triggered
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │  Preview Live   │◀─────────────┐
                                    │ (preview_live)  │              │
                                    └────────┬────────┘              │
                                             │                       │
                              Create release PR           More changes
                                             │              (restart)
                                             ▼                       │
                                    ┌─────────────────┐              │
                                    │ Release Pending │──────────────┘
                                    │(release_pending)│
                                    └────────┬────────┘
                                             │
                                    Approve release
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │ Merged to Main  │
                                    │ (merged_main)   │
                                    └────────┬────────┘
                                             │
                            Production deployment triggered
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │ Production Live │
                                    │(production_live)│
                                    └────────┬────────┘
                                             │
                                    Verify & complete
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │   Completed     │
                                    │  (completed)    │
                                    └─────────────────┘


═══════════════════════════════════════════════════════════════
                        HOTFIX TRACK
═══════════════════════════════════════════════════════════════

    ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
    │  Incident   │────▶│ Hotfix PR   │────▶│ Merged to   │
    │  Created    │     │  Created    │     │    Main     │
    └─────────────┘     └─────────────┘     └──────┬──────┘
                                                   │
                                    ┌──────────────┴──────────────┐
                                    │                             │
                                    ▼                             ▼
                           ┌─────────────┐              ┌─────────────┐
                           │ Production  │              │Reverse Sync │
                           │  Deployed   │              │ PR Created  │
                           └─────────────┘              └──────┬──────┘
                                                               │
                                                    Merge reverse sync
                                                               │
                                                               ▼
                                                      ┌─────────────┐
                                                      │  Completed  │
                                                      │(synced back)│
                                                      └─────────────┘
```

---

## API Endpoints

### Trace Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/traces` | GET | List traces with filters |
| `/api/traces` | POST | Create new trace manually |
| `/api/traces/[id]` | GET | Get trace details + events |
| `/api/traces/[id]` | PATCH | Update trace (manual actions) |
| `/api/traces/[id]/events` | GET | Get trace event timeline |
| `/api/traces/pending` | GET | Get all pending actions |
| `/api/traces/summary` | GET | Dashboard summary stats |

### Webhook Handlers

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhooks/github/events` | POST | GitHub webhook receiver |
| `/api/webhooks/cloudflare/deploy` | POST | Cloudflare deploy hooks |

---

## Dashboard UI

### Release Trace Dashboard (`/releases`)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  RELEASE TRACE                                                          │
│  Single view of all release activity                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─── PENDING ACTIONS (3) ──────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │  🔴 Approve Release PR #45                                        │  │
│  │     feature/user-auth → main                                      │  │
│  │     Ready since 2 hours ago                      [Approve] [View] │  │
│  │                                                                   │  │
│  │  🟡 Verify Preview Deployment                                     │  │
│  │     feature/checkout-fix on preview.pages.dev                     │  │
│  │     Deployed 30 mins ago                        [Verified] [View] │  │
│  │                                                                   │
│  │  🟠 Merge Reverse Sync PR #48                                     │  │
│  │     Hotfix main → develop                                         │  │
│  │     Created 1 hour ago                           [Merge] [View]   │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── ACTIVE TRACES ────────────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │  ┌────────────────────────────────────────────────────────────┐  │  │
│  │  │ 🚀 Add user authentication                                 │  │  │
│  │  │    feature/user-auth                                       │  │  │
│  │  │                                                            │  │  │
│  │  │  [Draft] ─▶ [Review] ─▶ [Develop] ─▶ [Preview] ─▶ [Main]  │  │  │
│  │  │                            ✓            ✓          ●       │  │  │
│  │  │                                                            │  │  │
│  │  │  Current: Awaiting release approval                        │  │  │
│  │  │  Preview: https://abc123.pages.dev                         │  │  │
│  │  └────────────────────────────────────────────────────────────┘  │  │
│  │                                                                   │  │
│  │  ┌────────────────────────────────────────────────────────────┐  │  │
│  │  │ 🔥 HOTFIX: Checkout latency fix                            │  │  │
│  │  │    hotfix/incident-a3f8-checkout                           │  │  │
│  │  │                                                            │  │  │
│  │  │  [Incident] ─▶ [PR] ─▶ [Main] ─▶ [Deploy] ─▶ [Sync]       │  │  │
│  │  │      ✓          ✓        ✓          ✓          ●          │  │  │
│  │  │                                                            │  │  │
│  │  │  Current: Reverse sync pending                             │  │  │
│  │  │  Incident: INC-a3f8 (resolved)                             │  │  │
│  │  └────────────────────────────────────────────────────────────┘  │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── RECENT COMPLETED ─────────────────────────────────────────────┐  │
│  │  ✅ Fix payment validation (2 days ago)                          │  │
│  │  ✅ Update dependencies (3 days ago)                             │  │
│  │  ✅ Add dark mode (5 days ago)                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Trace Detail View (`/releases/[id]`)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Traces                                                       │
│                                                                         │
│  Add user authentication                                    🟢 Active   │
│  feature/user-auth → develop → main                                     │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  PROGRESS                                                               │
│  ═══════════════════════════════════════════════════════════════════   │
│  [✓ Draft] ─▶ [✓ Review] ─▶ [✓ Develop] ─▶ [✓ Preview] ─▶ [● Main]    │
│                                                                         │
│  ┌─── PENDING ACTION ───────────────────────────────────────────────┐  │
│  │  🔴 Approve Release PR #45                                        │  │
│  │                                                                   │  │
│  │  The feature has been tested on preview. Ready for production.   │  │
│  │                                                                   │  │
│  │  [Approve and Deploy]  [Request Changes]  [View PR]              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── DETAILS ──────────────────────────────────────────────────────┐  │
│  │  Draft PR        #42  (merged)                                   │  │
│  │  Release PR      #45  (open)                                     │  │
│  │  Preview URL     https://abc123.pages.dev                        │  │
│  │  Commits         8 commits                                       │  │
│  │  Author          @developer                                      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─── TIMELINE ─────────────────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │  ● 2h ago   Release PR #45 created                               │  │
│  │             Awaiting approval for production                      │  │
│  │                                                                   │  │
│  │  ● 3h ago   Preview deployment succeeded                         │  │
│  │             https://abc123.pages.dev                              │  │
│  │                                                                   │  │
│  │  ● 4h ago   Merged to develop                                    │  │
│  │             SHA: abc1234                                          │  │
│  │                                                                   │  │
│  │  ● 1d ago   PR #42 approved                                      │  │
│  │             Approved by @reviewer                                 │  │
│  │                                                                   │  │
│  │  ● 2d ago   PR #42 opened                                        │  │
│  │             feature/user-auth → develop                           │  │
│  │                                                                   │  │
│  │  ● 2d ago   Trace created                                        │  │
│  │             Started tracking feature/user-auth                    │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Telegram Integration

### Commands

| Command | Description |
|---------|-------------|
| `/status` | Show pending actions summary |
| `/traces` | List active release traces |
| `/trace <id>` | Show specific trace details |
| `/approve <pr>` | Approve a release PR |
| `/verify <trace>` | Mark deployment as verified |

### Example Conversations

```
User: /status

Bot: 📊 *ShipBrain Status*

     *Pending Actions (3):*

     🔴 *Approve Release*
        PR #45: Add user authentication
        → Reply: `approve 45`

     🟡 *Verify Preview*
        feature/checkout-fix
        → Reply: `verify abc123`

     🟠 *Merge Reverse Sync*
        PR #48: Hotfix sync
        → Reply: `merge 48`

     ─────────────────
     Active traces: 2
     Completed today: 1
```

```
User: /traces

Bot: 🚀 *Active Release Traces*

     1️⃣ *Add user authentication*
        `feature/user-auth`
        Status: Awaiting release approval
        Phase: ████████░░ 80%

     2️⃣ *Hotfix: Checkout fix*
        `hotfix/incident-a3f8`
        Status: Reverse sync pending
        Phase: █████████░ 90%

     Reply with trace number for details.
```

```
User: 1

Bot: 📋 *Trace: Add user authentication*

     Branch: `feature/user-auth`
     Type: Feature

     *Progress:*
     ✅ Draft PR → ✅ Review → ✅ Develop → ✅ Preview → 🔴 Main

     *Current Action:*
     Approve release PR #45 for production

     *Links:*
     • [Draft PR #42](https://github.com/...)
     • [Release PR #45](https://github.com/...)
     • [Preview](https://abc123.pages.dev)

     Reply `approve 45` to deploy to production.
```

---

## File Structure

```
lib/
  orchestrator/
    index.ts              # Main orchestrator class
    state-machine.ts      # State transition logic
    event-processor.ts    # Process incoming events
    pending-actions.ts    # Determine pending actions
    types.ts              # Type definitions

  webhooks/
    github-events.ts      # GitHub webhook handler
    cloudflare-deploy.ts  # Cloudflare webhook handler

app/
  api/
    traces/
      route.ts            # List/create traces
      [id]/
        route.ts          # Get/update trace
        events/
          route.ts        # Get trace events
      pending/
        route.ts          # Get pending actions
      summary/
        route.ts          # Dashboard stats

    webhooks/
      github/
        events/
          route.ts        # GitHub webhook receiver
      cloudflare/
        deploy/
          route.ts        # Cloudflare deploy hook

  (dashboard)/
    releases/
      page.tsx            # Release trace dashboard
      [id]/
        page.tsx          # Trace detail view

components/
  releases/
    TraceCard.tsx         # Trace summary card
    TraceTimeline.tsx     # Event timeline
    PendingActions.tsx    # Pending action cards
    ProgressBar.tsx       # Visual progress indicator

supabase/
  migrations/
    XXX_release_traces.sql
```

---

## Implementation Phases

### Phase 1: Core Data Model (Day 1-2)
- [ ] Create database schema
- [ ] Define TypeScript types
- [ ] Build state machine logic
- [ ] Create basic CRUD APIs

### Phase 2: Webhook Integration (Day 2-3)
- [ ] GitHub webhook receiver
- [ ] Cloudflare deploy hook
- [ ] Event processor
- [ ] Auto-create traces from PRs

### Phase 3: Dashboard UI (Day 3-5)
- [ ] Release trace list page
- [ ] Trace detail view
- [ ] Pending actions component
- [ ] Timeline visualization

### Phase 4: Telegram Integration (Day 5-6)
- [ ] Add trace tools to bot
- [ ] Status command
- [ ] Approval via Telegram
- [ ] Push notifications for pending actions

### Phase 5: Polish & Testing (Day 6-7)
- [ ] Error handling
- [ ] Edge cases
- [ ] Performance optimization
- [ ] Documentation

---

## Key Benefits

1. **Single Source of Truth**: One place to see all release activity
2. **Workflow Independent**: Works via webhooks, not dependent on Actions
3. **Clear Pending Actions**: Users know exactly what needs attention
4. **Full Audit Trail**: Every event recorded with timestamp and actor
5. **Multi-Channel**: Same data powers dashboard and Telegram
6. **Hotfix Tracking**: Special handling for incident-driven releases

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Time to understand release status | < 10 seconds |
| Pending actions visible | 100% |
| Event capture accuracy | > 99% |
| Telegram response time | < 2 seconds |

---

## Dependencies

```json
{
  "dependencies": {
    "@octokit/webhooks": "^12.0.0",  // GitHub webhook verification
    "telegraf": "^4.16.0"            // Optional: Telegram bot
  }
}
```

---

## Security Considerations

1. **Webhook Verification**: Validate GitHub/Cloudflare webhook signatures
2. **User Authorization**: Ensure users can only see their own traces
3. **Action Authentication**: Verify identity before approvals
4. **Audit Logging**: Record all actions with actor information
5. **Rate Limiting**: Prevent webhook abuse

---

## Estimated Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Phase 1 | 2 days | Core data model + APIs |
| Phase 2 | 2 days | Webhook integration |
| Phase 3 | 3 days | Dashboard UI |
| Phase 4 | 2 days | Telegram integration |
| Phase 5 | 2 days | Polish + testing |
| **Total** | **11 days** | Full orchestrator system |

---

## Next Steps

1. Review and approve this plan
2. Create database migration
3. Start with Phase 1 implementation
4. Set up GitHub webhook in repo settings
5. Iterate based on usage feedback
