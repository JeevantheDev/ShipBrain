/**
 * Unified Action: Sync Spec from GitHub
 *
 * Syncs a spec's status with the actual PR status on GitHub.
 * Used by: Deployment Queue, webhooks, background jobs
 */

import { getOctokit } from "@/lib/github/client";
import { createOrUpdateTrace } from "@/lib/orchestrator";
import {
  ActionContext,
  ActionResult,
  SyncSpecInput,
  SyncSpecResult,
  ChainUpdate,
  SpecStatus
} from "./types";
import {
  logAction,
  logError,
  splitRepo,
  getSpecById,
  updateSpec,
  success,
  failure
} from "./utils";

/**
 * Sync a spec with GitHub PR status
 *
 * @param ctx - Action context with db, user, token
 * @param input - Sync spec input
 * @returns Action result with sync details
 */
export async function syncSpecFromGitHub(
  ctx: ActionContext,
  input: SyncSpecInput
): Promise<ActionResult<SyncSpecResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("syncSpecFromGitHub", ctx, { input });

  try {
    const spec = await getSpecById(ctx.db, input.specId);

    if (!spec) {
      return failure("Spec not found.");
    }

    if (!spec.pr_number || !spec.repo_full_name) {
      return failure("Spec has no PR number or repo name.");
    }

    // Only sync specs that might have changed
    if (!["draft_created", "pending_pr"].includes(spec.status)) {
      return success("Spec is already in a final state.", {
        specId: spec.id,
        previousStatus: spec.status as SpecStatus,
        newStatus: spec.status as SpecStatus,
        prMerged: spec.status === "merged",
        traceUpdated: false
      });
    }

    const { owner, repo } = splitRepo(spec.repo_full_name);
    const octokit = getOctokit(ctx.githubToken);

    // Fetch PR from GitHub
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: spec.pr_number
    });

    const previousStatus = spec.status as SpecStatus;
    const nextStatus: SpecStatus = pr.merged
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : pr.draft
          ? "draft_created"
          : "pending_pr";

    const nextBaseBranch = pr.base?.ref ?? spec.base_branch;
    const nextBranchName = pr.head?.ref ?? spec.branch_name;
    const nextMergeSha = pr.merged ? pr.merge_commit_sha ?? spec.merge_sha : spec.merge_sha;

    // Check if anything changed
    if (
      nextStatus === spec.status &&
      nextBaseBranch === spec.base_branch &&
      nextBranchName === spec.branch_name &&
      nextMergeSha === spec.merge_sha
    ) {
      return success("Spec is already up to date.", {
        specId: spec.id,
        previousStatus,
        newStatus: nextStatus,
        prMerged: false,
        traceUpdated: false
      });
    }

    // Build update object
    const updates: Record<string, any> = {
      status: nextStatus,
      pr_url: pr.html_url ?? spec.pr_url,
      branch_name: nextBranchName,
      base_branch: nextBaseBranch,
      feature_head_sha: pr.head?.sha ?? spec.feature_head_sha,
      feature_last_synced_at: new Date().toISOString()
    };

    if (nextStatus === "merged") {
      updates.merged_at = pr.merged_at ?? new Date().toISOString();
      updates.merge_sha = nextMergeSha;

      // Set release_status based on target branch
      const hasNoReleaseStatus = !spec.release_status || spec.release_status === "not_started";
      if (nextBaseBranch === "develop" && hasNoReleaseStatus) {
        updates.release_status = "ready_for_prod";
      } else if (nextBaseBranch === "main" && spec.release_status !== "deployed" && spec.release_status !== "deploying") {
        updates.release_status = "pending_deploy";
        updates.release_pr_status = "merged";
      }
    }

    // Update spec
    await updateSpec(ctx.db, spec.id, updates, chainUpdates);

    // Determine trace type and status
    const traceType = nextBranchName?.startsWith("hotfix/")
      ? "hotfix"
      : nextBranchName === "develop" && nextBaseBranch === "main"
        ? "release"
        : "feature";

    const traceStatus = nextStatus === "merged"
      ? nextBaseBranch === "main"
        ? "merged_main"
        : "merged_develop"
      : nextStatus === "closed"
        ? "cancelled"
        : pr.draft
          ? "draft"
          : "ready_for_review";

    // Update release trace
    let traceUpdated = false;
    try {
      await createOrUpdateTrace({
        repoFullName: spec.repo_full_name,
        type: traceType,
        title: pr.title ?? `PR #${spec.pr_number}`,
        description: pr.body ?? null,
        status: traceStatus,
        sourceBranch: nextBranchName ?? spec.branch_name,
        targetBranch: nextBaseBranch ?? spec.base_branch,
        draftPrNumber: spec.pr_number,
        draftPrUrl: pr.html_url ?? spec.pr_url,
        releasePrNumber: nextBranchName === "develop" && nextBaseBranch === "main" ? spec.pr_number : null,
        releasePrUrl: nextBranchName === "develop" && nextBaseBranch === "main" ? pr.html_url ?? spec.pr_url : null,
        specId: spec.id,
        source: ctx.source,
        actor: ctx.actor,
        eventType: nextStatus === "merged" ? "pr_merged" : "pr_updated",
        details: {
          prNumber: spec.pr_number,
          merged: pr.merged,
          mergeCommitSha: nextMergeSha,
          syncSource: ctx.source
        }
      });
      traceUpdated = true;
    } catch (err) {
      logError("syncSpecFromGitHub:trace", ctx, err);
    }

    logAction("syncSpecFromGitHub:success", ctx, {
      specId: spec.id,
      previousStatus,
      newStatus: nextStatus,
      prMerged: pr.merged,
      traceUpdated
    });

    return success(
      `Spec synced: ${previousStatus} → ${nextStatus}`,
      {
        specId: spec.id,
        previousStatus,
        newStatus: nextStatus,
        prMerged: pr.merged,
        traceUpdated
      },
      chainUpdates
    );

  } catch (error) {
    logError("syncSpecFromGitHub", ctx, error);
    return failure(
      `Failed to sync spec: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}

/**
 * Sync multiple specs from GitHub
 */
export async function syncMultipleSpecs(
  ctx: ActionContext,
  specIds: string[]
): Promise<ActionResult<{ synced: number; failed: number; results: SyncSpecResult[] }>> {
  logAction("syncMultipleSpecs", ctx, { count: specIds.length });

  const results: SyncSpecResult[] = [];
  let synced = 0;
  let failed = 0;

  for (const specId of specIds) {
    const result = await syncSpecFromGitHub(ctx, { specId });
    if (result.ok && result.data) {
      results.push(result.data);
      synced++;
    } else {
      failed++;
    }
  }

  return success(
    `Synced ${synced} specs, ${failed} failed.`,
    { synced, failed, results }
  );
}
