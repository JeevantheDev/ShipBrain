/**
 * Unified Action: Merge Reverse Sync PR
 *
 * Merges the reverse sync PR that syncs hotfix changes from main back to develop.
 * Completes the hotfix trace lifecycle.
 * Used by: UI, AI Chat, Telegram
 */

import { mergePullRequest } from "@/lib/github/pr";
import {
  ActionContext,
  ActionResult,
  MergeReverseSyncInput,
  MergeReverseSyncResult,
  ChainUpdate
} from "./types";
import {
  logAction,
  logError,
  splitRepo,
  createNotification,
  success,
  failure
} from "./utils";

/**
 * Merge the reverse sync PR for a hotfix
 *
 * @param ctx - Action context with db, user, token
 * @param input - Merge reverse sync input
 * @returns Action result with merge details
 */
export async function mergeReverseSync(
  ctx: ActionContext,
  input: MergeReverseSyncInput
): Promise<ActionResult<MergeReverseSyncResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("mergeReverseSync", ctx, { input });

  try {
    // Get the incident
    const { data: incident, error: incidentError } = await ctx.db
      .from("incidents")
      .select("id, title, repo_full_name, reverse_sync_pr_number, reverse_sync_pr_status")
      .eq("id", input.incidentId)
      .eq("user_id", ctx.userId)
      .single();

    if (incidentError || !incident) {
      return failure("Unable to load incident or incident not found.");
    }

    if (!incident.reverse_sync_pr_number) {
      return failure("No reverse sync PR exists for this incident.");
    }

    if (incident.reverse_sync_pr_status === "merged") {
      return failure("Reverse sync PR is already merged.");
    }

    if (!incident.repo_full_name?.includes("/")) {
      return failure("Incident is not linked to a connected GitHub repository.");
    }

    // Get the associated trace
    const { data: trace, error: traceError } = await ctx.db
      .from("release_traces")
      .select("id, title, reverse_sync_pr_number, status")
      .eq("incident_id", input.incidentId)
      .eq("user_id", ctx.userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (traceError) {
      logError("mergeReverseSync:traceLookup", ctx, traceError);
    }

    const { owner, repo } = splitRepo(incident.repo_full_name);

    // Merge the reverse sync PR
    const merge = await mergePullRequest({
      owner,
      repo,
      pullNumber: incident.reverse_sync_pr_number,
      commitTitle: `sync: complete hotfix reverse sync for ${incident.title ?? input.incidentId.slice(0, 8)}`,
      token: ctx.githubToken
    });

    logAction("mergeReverseSync:merged", ctx, { mergeSha: merge.sha });

    // Update incident
    const { error: incidentUpdateError } = await ctx.db
      .from("incidents")
      .update({
        reverse_sync_pr_status: "merged",
        reverse_sync_merged_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", input.incidentId);

    if (incidentUpdateError) {
      logError("mergeReverseSync:incidentUpdate", ctx, incidentUpdateError);
    }

    // Update release trace if exists
    let traceCompleted = false;
    if (trace) {
      const { error: traceUpdateError } = await ctx.db
        .from("release_traces")
        .update({
          status: "completed",
          current_phase: "live",
          reverse_sync_status: "merged",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", trace.id);

      if (traceUpdateError) {
        logError("mergeReverseSync:traceUpdate", ctx, traceUpdateError);
      } else {
        traceCompleted = true;
      }

      // Add trace event
      await ctx.db.from("trace_events").insert({
        trace_id: trace.id,
        event_type: "reverse_sync_merged",
        actor: ctx.actor,
        actor_type: ctx.source === "telegram" ? "bot" : "user",
        source: ctx.source,
        details: {
          mergeSha: merge.sha,
          incidentId: input.incidentId,
          reverseSyncPrNumber: incident.reverse_sync_pr_number
        }
      });
    }

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "reverse_sync_merged",
      title: "Reverse Sync Completed",
      body: `Hotfix for "${incident.title ?? input.incidentId.slice(0, 8)}" has been synced to develop`,
      severity: "success",
      repoFullName: incident.repo_full_name,
      metadata: {
        incidentId: input.incidentId,
        traceId: trace?.id,
        mergeSha: merge.sha,
        source: ctx.source
      }
    });

    logAction("mergeReverseSync:success", ctx, {
      incidentId: input.incidentId,
      traceId: trace?.id,
      mergeSha: merge.sha,
      traceCompleted
    });

    return success(
      `Reverse sync merged successfully. Hotfix lifecycle completed.`,
      {
        incidentId: input.incidentId,
        traceId: trace?.id ?? "",
        mergeSha: merge.sha,
        traceCompleted
      },
      chainUpdates
    );

  } catch (error) {
    logError("mergeReverseSync", ctx, error);
    return failure(
      `Failed to merge reverse sync: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
