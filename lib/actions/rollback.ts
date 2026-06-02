/**
 * Unified Action: Rollback
 *
 * Rolls back production to a previous release tag.
 * Updates all linked features and traces in the chain.
 * Used by: UI, AI Chat, Telegram
 */

import { dispatchCloudflareProductionDeploy } from "@/lib/github/deployments";
import { updateTraceBySpec } from "@/lib/orchestrator";
import {
  ActionContext,
  ActionResult,
  RollbackInput,
  RollbackResult,
  ChainUpdate
} from "./types";
import {
  logAction,
  logError,
  splitRepo,
  getTracesByReleaseTag,
  updateLinkedSpecs,
  updateLinkedTraces,
  createNotification,
  success,
  failure
} from "./utils";

/**
 * Rollback to a previous release
 *
 * @param ctx - Action context with db, user, token
 * @param input - Rollback input with target release tag
 * @returns Action result with rollback details
 */
export async function rollback(
  ctx: ActionContext,
  input: RollbackInput
): Promise<ActionResult<RollbackResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("rollback", ctx, { input });

  try {
    const repoFullName = input.repoFullName || ctx.repoFullName;
    if (!repoFullName?.includes("/")) {
      return failure("Repository name is required.");
    }

    const targetReleaseTag = input.targetReleaseTag;
    if (!targetReleaseTag) {
      return failure("Target release tag is required for rollback.");
    }

    const { owner, repo } = splitRepo(repoFullName);

    // Find the target release spec
    const { data: targetSpec } = await ctx.db
      .from("specs")
      .select("*")
      .eq("repo_full_name", repoFullName)
      .eq("release_tag", targetReleaseTag)
      .eq("release_status", "deployed")
      .order("deployed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!targetSpec) {
      return failure(`Release ${targetReleaseTag} not found or was never deployed.`);
    }

    // Find current production release
    const { data: currentSpecs } = await ctx.db
      .from("specs")
      .select("*")
      .eq("repo_full_name", repoFullName)
      .eq("release_status", "deployed")
      .order("deployed_at", { ascending: false })
      .limit(1);

    const currentSpec = currentSpecs?.[0];
    const currentReleaseTag = currentSpec?.release_tag;

    if (currentReleaseTag === targetReleaseTag) {
      return failure(`${targetReleaseTag} is already the current production release.`);
    }

    logAction("rollback:dispatch", ctx, {
      fromTag: currentReleaseTag,
      toTag: targetReleaseTag,
      targetSha: targetSpec.release_sha
    });

    // Dispatch production deployment with the target release tag
    const deployment = await dispatchCloudflareProductionDeploy({
      owner,
      repo,
      releaseTag: targetReleaseTag,
      releaseSha: targetSpec.release_sha,
      token: ctx.githubToken
    });

    // Create rollback history record
    const { data: rollbackRecord } = await ctx.db
      .from("rollback_history")
      .insert({
        user_id: ctx.userId,
        repo_full_name: repoFullName,
        spec_id: targetSpec.id,
        source_release_tag: currentReleaseTag || "unknown",
        target_release_tag: targetReleaseTag,
        target_release_sha: targetSpec.release_sha,
        status: "deploying",
        initiated_by: ctx.actor,
        workflow_url: deployment.workflowUrl,
        metadata: {
          source: ctx.source,
          currentSpecId: currentSpec?.id
        }
      })
      .select("id")
      .maybeSingle();

    // Mark current release and its features as "rolled_back"
    let specsRolledBack = 0;
    let tracesUpdated = 0;
    let featuresRolledBack = 0;

    if (currentReleaseTag && currentSpec) {
      // 1. Update the release spec itself (the one with the release_tag)
      specsRolledBack = await updateLinkedSpecs(
        ctx.db,
        repoFullName,
        currentReleaseTag,
        null,
        {
          release_status: "rolled_back"
        } as any
      );

      // 2. Find and update all feature specs that were part of this release
      // Features are linked via release_pr_number (the PR that merged develop->main)
      if (currentSpec.release_pr_number) {
        const { data: featureSpecs } = await ctx.db
          .from("specs")
          .select("id")
          .eq("repo_full_name", repoFullName)
          .eq("release_pr_number", currentSpec.release_pr_number)
          .neq("id", currentSpec.id);

        if (featureSpecs?.length) {
          const featureIds = featureSpecs.map(s => s.id);

          // Mark feature specs as rolled_back
          await ctx.db
            .from("specs")
            .update({
              release_status: "rolled_back",
              updated_at: new Date().toISOString()
            })
            .in("id", featureIds);

          featuresRolledBack = featureIds.length;

          // Update feature traces to rolled_back status and add audit events
          for (const featureId of featureIds) {
            // Get the trace for this feature
            const { data: featureTrace } = await ctx.db
              .from("release_traces")
              .select("id, title")
              .eq("spec_id", featureId)
              .maybeSingle();

            if (featureTrace) {
              // Update trace status
              await ctx.db
                .from("release_traces")
                .update({
                  status: "rolled_back",
                  rollback_metadata: {
                    rolledBackAt: new Date().toISOString(),
                    rolledBackTo: targetReleaseTag,
                    rolledBackFrom: currentReleaseTag,
                    initiatedBy: ctx.actor,
                    source: ctx.source
                  },
                  updated_at: new Date().toISOString()
                })
                .eq("id", featureTrace.id);

              // Add audit trail event
              await ctx.db.from("trace_events").insert({
                trace_id: featureTrace.id,
                event_type: "feature_rolled_back",
                actor: ctx.actor,
                actor_type: ctx.source === "system" || ctx.source === "webhook" ? "system" : "user",
                source: ctx.source,
                details: {
                  rolledBackFrom: currentReleaseTag,
                  rolledBackTo: targetReleaseTag,
                  reason: `Feature was part of release ${currentReleaseTag} which was rolled back to ${targetReleaseTag}`
                }
              });
            }
          }
        }
      }

      // 3. Update traces with current release tag (release traces)
      tracesUpdated = await updateLinkedTraces(
        ctx.db,
        repoFullName,
        currentReleaseTag,
        null,
        {
          status: "rolled_back",
          rollback_metadata: {
            rolledBackAt: new Date().toISOString(),
            rolledBackTo: targetReleaseTag,
            initiatedBy: ctx.actor,
            source: ctx.source
          }
        } as any
      );
    }

    // 4. Re-mark the target release as "deployed" so it shows as current
    await ctx.db
      .from("specs")
      .update({
        release_status: "deployed",
        updated_at: new Date().toISOString()
      })
      .eq("id", targetSpec.id);

    // 5. Also update any feature specs that were part of the target release back to deployed
    if (targetSpec.release_pr_number) {
      await ctx.db
        .from("specs")
        .update({
          release_status: "deployed",
          updated_at: new Date().toISOString()
        })
        .eq("repo_full_name", repoFullName)
        .eq("release_pr_number", targetSpec.release_pr_number);

      // 6. Update feature traces for target release back to production_live
      const { data: targetFeatureSpecs } = await ctx.db
        .from("specs")
        .select("id")
        .eq("repo_full_name", repoFullName)
        .eq("release_pr_number", targetSpec.release_pr_number);

      if (targetFeatureSpecs?.length) {
        for (const spec of targetFeatureSpecs) {
          const { data: trace } = await ctx.db
            .from("release_traces")
            .select("id")
            .eq("spec_id", spec.id)
            .maybeSingle();

          if (trace) {
            await ctx.db
              .from("release_traces")
              .update({
                status: "production_live",
                updated_at: new Date().toISOString()
              })
              .eq("id", trace.id);

            // Add audit event for restored feature
            await ctx.db.from("trace_events").insert({
              trace_id: trace.id,
              event_type: "feature_restored",
              actor: ctx.actor,
              actor_type: ctx.source === "system" || ctx.source === "webhook" ? "system" : "user",
              source: ctx.source,
              details: {
                restoredViaRollback: true,
                releaseTag: targetReleaseTag,
                rolledBackFrom: currentReleaseTag
              }
            });
          }
        }
      }
    }

    // Update target release trace to show it's being redeployed
    const targetTraces = await getTracesByReleaseTag(ctx.db, repoFullName, targetReleaseTag);
    for (const trace of targetTraces) {
      await updateTraceBySpec(targetSpec.id, {
        status: "production_live",
        production_deployment: {
          status: "deploying",
          tag: targetReleaseTag,
          releaseTag: targetReleaseTag,
          sha: targetSpec.release_sha,
          url: deployment.workflowUrl,
          isRollback: true,
          rollbackFrom: currentReleaseTag,
          timestamp: new Date().toISOString()
        }
      }, {
        eventType: "rollback_initiated",
        source: ctx.source,
        actor: ctx.actor,
        actorType: ctx.source === "system" || ctx.source === "webhook" ? "system" : "user",
        details: {
          targetReleaseTag,
          sourceReleaseTag: currentReleaseTag,
          workflowUrl: deployment.workflowUrl,
          rollbackId: rollbackRecord?.id
        }
      }).catch(err => logError("rollback:updateTargetTrace", ctx, err));
    }

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "rollback_initiated",
      title: "Rollback Initiated",
      body: `Rolling back from ${currentReleaseTag || "current"} to ${targetReleaseTag}`,
      href: deployment.workflowUrl,
      severity: "warning",
      repoFullName,
      metadata: {
        targetReleaseTag,
        sourceReleaseTag: currentReleaseTag,
        rollbackId: rollbackRecord?.id,
        source: ctx.source
      }
    });

    logAction("rollback:success", ctx, {
      rollbackId: rollbackRecord?.id,
      sourceTag: currentReleaseTag,
      targetTag: targetReleaseTag,
      specsRolledBack,
      featuresRolledBack,
      tracesUpdated,
      workflowUrl: deployment.workflowUrl
    });

    return success(
      `Rollback to ${targetReleaseTag} initiated. ${specsRolledBack + featuresRolledBack} specs and ${tracesUpdated} traces rolled back.`,
      {
        rollbackId: rollbackRecord?.id || "",
        sourceTag: currentReleaseTag || "unknown",
        targetTag: targetReleaseTag,
        workflowUrl: deployment.workflowUrl,
        specsRolledBack: specsRolledBack + featuresRolledBack,
        tracesUpdated
      },
      chainUpdates
    );

  } catch (error) {
    logError("rollback", ctx, error);
    return failure(
      `Failed to initiate rollback: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}

/**
 * Get available releases for rollback
 */
export async function getAvailableReleases(
  ctx: ActionContext,
  repoFullName: string
): Promise<ActionResult<Array<{ releaseTag: string; deployedAt: string; specId: string; title: string }>>> {
  logAction("getAvailableReleases", ctx, { repoFullName });

  try {
    const { data: specs } = await ctx.db
      .from("specs")
      .select("id, release_tag, deployed_at, decomposed_tasks")
      .eq("repo_full_name", repoFullName)
      .eq("release_status", "deployed")
      .not("release_tag", "is", null)
      .order("deployed_at", { ascending: false })
      .limit(20);

    const releases = (specs || []).map(s => ({
      releaseTag: s.release_tag,
      deployedAt: s.deployed_at,
      specId: s.id,
      title: (s.decomposed_tasks as any)?.prTitle || `Release ${s.release_tag}`
    }));

    return success("Available releases retrieved.", releases);

  } catch (error) {
    logError("getAvailableReleases", ctx, error);
    return failure(`Failed to get available releases: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
