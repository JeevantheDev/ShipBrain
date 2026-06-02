/**
 * Unified Action: Sync Hotfix
 *
 * Syncs commits from a hotfix PR.
 * Used by: UI, AI Chat, Telegram
 */

import { listPullRequestCommits } from "@/lib/github/commits";
import {
  ActionContext,
  ActionResult,
  SyncHotfixInput,
  SyncHotfixResult,
  ChainUpdate
} from "./types";
import {
  logAction,
  logError,
  splitRepo,
  success,
  failure
} from "./utils";

/**
 * Sync commits from a hotfix PR
 *
 * @param ctx - Action context with db, user, token
 * @param input - Sync hotfix input
 * @returns Action result with synced commits
 */
export async function syncHotfix(
  ctx: ActionContext,
  input: SyncHotfixInput
): Promise<ActionResult<SyncHotfixResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("syncHotfix", ctx, { input });

  try {
    // Get incident
    const { data: incident, error: incidentError } = await ctx.db
      .from("incidents")
      .select("*")
      .eq("id", input.incidentId)
      .eq("user_id", ctx.userId)
      .single();

    if (incidentError || !incident) {
      return failure("Unable to load incident or incident not found.");
    }

    if (!incident.hotfix_pr_number) {
      return failure("No hotfix PR is linked to this incident yet.");
    }

    if (!incident.repo_full_name?.includes("/")) {
      return failure("Incident is not linked to a connected GitHub repository.");
    }

    const { owner, repo } = splitRepo(incident.repo_full_name);

    // Fetch latest commits
    const commits = await listPullRequestCommits({ owner, repo, pullNumber: incident.hotfix_pr_number });

    // Update incident
    const { error: updateError } = await ctx.db
      .from("incidents")
      .update({
        hotfix_commits: commits,
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", ctx.userId);

    if (updateError) {
      logError("syncHotfix:update", ctx, updateError);
      return failure("Unable to refresh hotfix commits.");
    }

    logAction("syncHotfix:success", ctx, {
      incidentId: incident.id,
      prNumber: incident.hotfix_pr_number,
      commitCount: commits.length
    });

    return success(
      `Synced ${commits.length} commits from hotfix PR #${incident.hotfix_pr_number}.`,
      {
        incidentId: incident.id,
        prNumber: incident.hotfix_pr_number,
        commits: commits.map((c: any) => ({ sha: c.sha, message: c.message }))
      },
      chainUpdates
    );

  } catch (error) {
    logError("syncHotfix", ctx, error);
    return failure(
      `Failed to sync hotfix: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
