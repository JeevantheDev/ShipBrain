export type ReleaseTraceStatus =
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
  | "cancelled";

export type ReleaseTraceType = "feature" | "hotfix" | "release";

export type PendingAction = {
  type:
    | "review_pr"
    | "approve_pr"
    | "merge_to_develop"
    | "verify_preview"
    | "create_release_pr"
    | "approve_release"
    | "merge_to_main"
    | "verify_production"
    | "merge_reverse_sync"
    | "resolve_conflict";
  description: string;
  actor?: string;
  blockedBy?: string[];
};

export type TraceEventType =
  | "trace_created"
  | "pr_opened"
  | "pr_updated"
  | "review_requested"
  | "review_submitted"
  | "pr_approved"
  | "pr_merged"
  | "deployment_started"
  | "deployment_succeeded"
  | "deployment_failed"
  | "release_pr_created"
  | "hotfix_created"
  | "reverse_sync_created"
  | "reverse_sync_merged"
  | "incident_linked"
  | "manual_action"
  | "status_changed";

export type TraceSource = "github" | "cloudflare" | "manual" | "telegram" | "system";
