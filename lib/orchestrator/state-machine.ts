import type { PendingAction, ReleaseTraceStatus } from "@/lib/orchestrator/types";

type TraceLike = {
  type?: string | null;
  status?: string | null;
  target_branch?: string | null;
  draft_pr_number?: number | null;
  release_pr_number?: number | null;
  preview_deployment?: { url?: string; status?: string } | null;
  production_deployment?: { url?: string; status?: string; releaseTag?: string } | null;
  reverse_sync_pr_number?: number | null;
  reverse_sync_status?: string | null;
  rollback_target_tag?: string | null;
};

export function phaseForStatus(status: ReleaseTraceStatus) {
  if (status === "draft" || status === "ready_for_review" || status === "approved") return "development";
  if (status === "merged_develop" || status === "preview_live") return "preview";
  if (status === "release_pending" || status === "merged_main" || status === "rolling_back") return "production";
  if (status === "production_live" || status === "completed" || status === "rolled_back") return "live";
  if (status === "failed") return "attention";
  return "closed";
}

export function phaseForTraceStatus(status: ReleaseTraceStatus, trace?: Pick<TraceLike, "type" | "target_branch"> | null) {
  const isProdHotfix = trace?.type === "hotfix" && trace.target_branch === "main";
  if (isProdHotfix && (status === "draft" || status === "ready_for_review" || status === "approved")) {
    return "production";
  }
  return phaseForStatus(status);
}

export function pendingActionForTrace(trace: TraceLike): PendingAction | null {
  const isProdHotfix = trace.type === "hotfix" && trace.target_branch === "main";
  switch (trace.status) {
    case "draft":
      return {
        type: "review_pr",
        description: trace.draft_pr_number
          ? isProdHotfix
            ? `Review hotfix PR #${trace.draft_pr_number} for production.`
            : `Review Draft PR #${trace.draft_pr_number} and move it forward.`
          : "Create or connect the Draft PR for this change.",
        actor: "developer"
      };
    case "ready_for_review":
    case "approved":
      return {
        type: "merge_to_develop",
        description: isProdHotfix
          ? `Approve the incident fix to merge hotfix PR #${trace.draft_pr_number ?? "n/a"} into main.`
          : `Merge PR #${trace.draft_pr_number ?? "n/a"} into ${trace.target_branch ?? "develop"}.`,
        actor: "developer"
      };
    case "merged_develop":
      return null;
    case "preview_live":
      if (isProdHotfix) return null;
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
        type: "deploy_to_production",
        description: trace.release_pr_number
          ? `Release PR #${trace.release_pr_number} merged. Enter release tag and deploy to production.`
          : "Release merged to main. Enter release tag and deploy to production.",
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
      return null;
    case "failed":
      return {
        type: "resolve_conflict",
        description: "A release step failed and needs manual attention.",
        actor: "developer"
      };
    case "rolling_back":
      return null;
    case "rolled_back":
      return null;
    default:
      return null;
  }
}
