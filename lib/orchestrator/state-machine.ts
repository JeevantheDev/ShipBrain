import type { PendingAction, ReleaseTraceStatus } from "@/lib/orchestrator/types";

type TraceLike = {
  status?: string | null;
  target_branch?: string | null;
  draft_pr_number?: number | null;
  release_pr_number?: number | null;
  preview_deployment?: { url?: string; status?: string } | null;
  production_deployment?: { url?: string; status?: string } | null;
  reverse_sync_pr_number?: number | null;
  reverse_sync_status?: string | null;
};

export function phaseForStatus(status: ReleaseTraceStatus) {
  if (status === "draft" || status === "ready_for_review" || status === "approved") return "development";
  if (status === "merged_develop" || status === "preview_live") return "preview";
  if (status === "release_pending" || status === "merged_main") return "production";
  if (status === "production_live" || status === "completed") return "live";
  if (status === "failed") return "attention";
  return "closed";
}

export function pendingActionForTrace(trace: TraceLike): PendingAction | null {
  switch (trace.status) {
    case "draft":
      return {
        type: "review_pr",
        description: trace.draft_pr_number
          ? `Review Draft PR #${trace.draft_pr_number} and move it forward.`
          : "Create or connect the Draft PR for this change.",
        actor: "developer"
      };
    case "ready_for_review":
    case "approved":
      return {
        type: "merge_to_develop",
        description: `Merge PR #${trace.draft_pr_number ?? "n/a"} into ${trace.target_branch ?? "develop"}.`,
        actor: "developer"
      };
    case "merged_develop":
      return {
        type: "verify_preview",
        description: "Validate the develop preview deployment before promoting to production.",
        actor: "manager"
      };
    case "preview_live":
      return {
        type: "create_release_pr",
        description: "Create a release PR from develop to main for production.",
        actor: "manager"
      };
    case "release_pending":
      return {
        type: "approve_release",
        description: `Approve and deploy release PR #${trace.release_pr_number ?? "n/a"}.`,
        actor: "manager"
      };
    case "merged_main":
      return {
        type: "verify_production",
        description: "Production deployment is running or waiting for verification.",
        actor: "manager"
      };
    case "production_live":
      if (trace.reverse_sync_pr_number && trace.reverse_sync_status !== "merged") {
        return {
          type: "merge_reverse_sync",
          description: `Merge reverse sync PR #${trace.reverse_sync_pr_number} to keep develop current.`,
          actor: "developer"
        };
      }
      return {
        type: "verify_production",
        description: "Verify production and mark this trace complete.",
        actor: "manager"
      };
    case "failed":
      return {
        type: "resolve_conflict",
        description: "A release step failed and needs manual attention.",
        actor: "developer"
      };
    default:
      return null;
  }
}
