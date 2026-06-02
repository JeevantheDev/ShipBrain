/**
 * Unified Actions Layer - Type Definitions
 *
 * These types ensure consistency across UI, AI Chat, and Telegram.
 * All actions return the same response structure.
 */

import { SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Action Context - Passed to every action
// ============================================================================

export type ActionSource = "ui" | "chat" | "telegram" | "webhook" | "system";

export interface ActionContext {
  /** Supabase client (admin or user-scoped) */
  db: SupabaseClient;
  /** User ID performing the action */
  userId: string;
  /** User's GitHub access token */
  githubToken: string;
  /** Where the action was triggered from */
  source: ActionSource;
  /** Actor name for audit trail */
  actor: string;
  /** Repository full name (owner/repo) */
  repoFullName: string;
}

// ============================================================================
// Action Results - Consistent response structure
// ============================================================================

export interface ActionResult<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
  error?: string;
  /** Chain of updates that occurred */
  chainUpdates?: ChainUpdate[];
}

export interface ChainUpdate {
  type: "spec" | "trace" | "incident";
  id: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

// ============================================================================
// Spec Types
// ============================================================================

export interface Spec {
  id: string;
  user_id: string;
  repo_full_name: string;
  branch_name: string | null;
  base_branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  status: SpecStatus;
  release_status: ReleaseStatus | null;
  release_pr_number: number | null;
  release_pr_url: string | null;
  release_pr_status: string | null;
  release_tag: string | null;
  release_sha: string | null;
  merge_sha: string | null;
  feature_head_sha: string | null;
  feature_last_synced_at: string | null;
  preview_status: PreviewStatus | null;
  preview_url: string | null;
  production_url: string | null;
  incident_id: string | null;
  decomposed_tasks: Record<string, unknown> | null;
  updated_at: string;
  merged_at: string | null;
}

export type SpecStatus =
  | "draft_created"
  | "pending_pr"
  | "merged"
  | "closed";

export type ReleaseStatus =
  | "not_started"
  | "ready_for_prod"
  | "pending_deploy"
  | "deploying"
  | "deployed"
  | "failed"
  | "rolled_back";

export type PreviewStatus =
  | "deploying"
  | "deployed"
  | "failed";

// ============================================================================
// Release Trace Types
// ============================================================================

export interface ReleaseTrace {
  id: string;
  repo_full_name: string;
  type: TraceType;
  status: TraceStatus;
  title: string;
  description: string | null;
  source_branch: string | null;
  target_branch: string | null;
  spec_id: string | null;
  draft_pr_number: number | null;
  release_pr_number: number | null;
  release_tag: string | null;
  incident_id: string | null;
  reverse_sync_pr_number: number | null;
  reverse_sync_status: string | null;
  preview_deployment: Record<string, unknown> | null;
  production_deployment: Record<string, unknown> | null;
  rollback_metadata: Record<string, unknown> | null;
  is_rollback: boolean;
  rollback_source_tag: string | null;
  rollback_target_tag: string | null;
  current_phase: string | null;
  pending_action: string | null;
  updated_at: string;
}

export type TraceType = "feature" | "release" | "hotfix";

export type TraceStatus =
  | "draft"
  | "ready_for_review"
  | "approved"
  | "merged_develop"
  | "preview_live"
  | "release_pending"
  | "merged_main"
  | "production_live"
  | "completed"
  | "failed"
  | "cancelled"
  | "rolling_back"
  | "rolled_back";

// ============================================================================
// Action Input Types
// ============================================================================

export interface DeployPreviewInput {
  specId?: string;
  /** If no specId, deploy latest merged specs for repo */
  repoFullName?: string;
  /** Force redeploy even if preview already exists */
  forceRedeploy?: boolean;
}

export interface DeployProductionInput {
  specId?: string;
  releaseTag?: string;
  releaseSha?: string;
  repoFullName?: string;
  /** Force redeploy even if already deployed */
  forceRedeploy?: boolean;
}

export interface CreateReleasePRInput {
  repoFullName: string;
  /** Features to include (by spec ID or PR number) */
  featureIds?: string[];
  /** Custom release tag, otherwise auto-generated */
  releaseTag?: string;
  /** PR title */
  title?: string;
  /** PR body */
  body?: string;
}

export interface RollbackInput {
  repoFullName: string;
  /** Release tag to rollback TO */
  targetReleaseTag: string;
}

export interface SyncSpecInput {
  specId: string;
}

export interface MergeReverseSyncInput {
  incidentId: string;
}

// ============================================================================
// Hotfix Input Types
// ============================================================================

export interface CreateHotfixInput {
  incidentId: string;
  /** Base branch for hotfix, defaults to "develop" */
  baseBranch?: string;
  /** AI analysis results to include in PR */
  analysis?: {
    rootCause?: string;
    fixProposal?: string;
    changeSummary?: string;
    releaseContext?: unknown;
  };
}

export interface ApproveHotfixInput {
  incidentId: string;
  /** Custom release tag, otherwise auto-generated */
  releaseTag?: string;
  /** Approval note for audit trail */
  note?: string;
}

export interface SyncHotfixInput {
  incidentId: string;
}

// ============================================================================
// Incident Input Types
// ============================================================================

export interface AnalyzeIncidentInput {
  incidentId: string;
  /** Additional context for analysis */
  releaseContext?: unknown;
}

export interface ResolveIncidentInput {
  incidentId: string;
  /** Resolution note */
  note?: string;
}

// ============================================================================
// Action Output Types
// ============================================================================

export interface DeployPreviewResult {
  specId: string;
  workflowUrl: string | null;
  previewUrl: string | null;
  status: PreviewStatus;
}

export interface DeployProductionResult {
  specId: string;
  releaseTag: string;
  releaseSha: string;
  workflowUrl: string | null;
  productionUrl: string | null;
  status: ReleaseStatus;
  linkedSpecsUpdated: number;
}

export interface CreateReleasePRResult {
  prNumber: number;
  prUrl: string;
  releaseTag: string;
  releaseSha: string;
  specId: string;
  featuresIncluded: number;
}

export interface RollbackResult {
  rollbackId: string;
  sourceTag: string;
  targetTag: string;
  workflowUrl: string | null;
  specsRolledBack: number;
  tracesUpdated: number;
}

export interface SyncSpecResult {
  specId: string;
  previousStatus: SpecStatus;
  newStatus: SpecStatus;
  prMerged: boolean;
  traceUpdated: boolean;
}

// ============================================================================
// Hotfix Output Types
// ============================================================================

export interface CreateHotfixResult {
  incidentId: string;
  specId: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  baseBranch: string;
  commits: Array<{
    sha: string;
    message: string;
  }>;
}

export interface ApproveHotfixResult {
  incidentId: string;
  merged: boolean;
  mergeSha: string | null;
  releaseTag: string | null;
  workflowUrl: string | null;
  reverseSync: {
    prNumber: number;
    prUrl: string;
    created: boolean;
  } | null;
  isProdDeploy: boolean;
}

export interface SyncHotfixResult {
  incidentId: string;
  prNumber: number;
  commits: Array<{
    sha: string;
    message: string;
  }>;
}

// ============================================================================
// Incident Output Types
// ============================================================================

export interface AnalyzeIncidentResult {
  incidentId: string;
  rootCause: string;
  fixProposal: string;
  rollbackSteps: string[];
  changeSummary: string;
  implicatedCommits: Array<{
    sha: string;
    message: string;
    reason: string;
    risk: string;
  }>;
  confidence: number;
}

export interface ResolveIncidentResult {
  incidentId: string;
  previousStatus: string;
  resolved: boolean;
}
