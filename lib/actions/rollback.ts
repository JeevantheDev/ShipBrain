/**
 * Unified Action: Rollback
 *
 * Rolls back production to a previous release tag.
 * Updates all linked features and traces in the chain.
 * Used by: UI, AI Chat, Telegram
 */

import { dispatchCloudflareProductionDeploy } from "@/lib/github/deployments";
import { updateTraceBySpec } from "@/lib/orchestrator";
import { getRepoCurrentVersion } from "@/lib/shipbrain/repo-version";
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

    // Find the target release spec - allow both deployed and rolled_back specs
    // (you might want to roll back to a previously rolled back version)
    const { data: targetSpec } = await ctx.db
      .from("specs")
      .select("*")
      .eq("repo_full_name", repoFullName)
      .eq("release_tag", targetReleaseTag)
      .in("release_status", ["deployed", "rolled_back"])
      .order("deployed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!targetSpec) {
      return failure(`Release ${targetReleaseTag} not found or was never deployed.`);
    }

    // Use canonical repos.current_version as the source of truth
    const currentVersionData = await getRepoCurrentVersion(ctx.db, repoFullName);
    const currentReleaseTag = currentVersionData?.version ?? null;

    // Find the current production spec for metadata (optional - may not exist)
    const { data: currentSpec } = currentReleaseTag
      ? await ctx.db
          .from("specs")
          .select("*")
          .eq("repo_full_name", repoFullName)
          .eq("release_tag", currentReleaseTag)
          .maybeSingle()
      : { data: null };

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

    if (currentReleaseTag) {
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

      // 2. Find the release TRACE directly to get its release_pr_number
      // Look for a release trace that has the current release tag in production_deployment
      // or find it via release_pr_number from the spec
      const { data: releaseTraces } = await ctx.db
        .from("release_traces")
        .select("id, release_pr_number, type, production_deployment")
        .eq("repo_full_name", repoFullName)
        .eq("type", "release")
        .in("status", ["production_live", "merged_main", "completed"]);

      // Find the trace that matches the current release tag
      const releaseTrace = releaseTraces?.find((t: any) => {
        const prodDeploy = t.production_deployment as { releaseTag?: string; tag?: string } | null;
        return prodDeploy?.releaseTag === currentReleaseTag || prodDeploy?.tag === currentReleaseTag;
      });

      // Get release_pr_number from either the trace or the spec
      const releasePrNumber = releaseTrace?.release_pr_number ?? currentSpec?.release_pr_number;

      logAction("rollback:findFeatures", ctx, {
        currentReleaseTag,
        releasePrNumber,
        releaseTraceFound: !!releaseTrace,
        currentSpecReleasePrNumber: currentSpec?.release_pr_number
      });

      // 3. Find and update all feature traces that were part of this release
      // Features are linked via release_pr_number on the traces table
      if (releasePrNumber) {
        // Find feature traces with the same release_pr_number
        const { data: featureTraces } = await ctx.db
          .from("release_traces")
          .select("id, spec_id, title")
          .eq("repo_full_name", repoFullName)
          .eq("release_pr_number", releasePrNumber)
          .eq("type", "feature")
          .in("status", ["production_live", "merged_main", "completed"]);

        if (featureTraces?.length) {
          featuresRolledBack = featureTraces.length;

          // Update each feature trace
          for (const featureTrace of featureTraces) {
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

            // Update linked spec if exists
            if (featureTrace.spec_id) {
              await ctx.db
                .from("specs")
                .update({
                  release_status: "rolled_back",
                  updated_at: new Date().toISOString()
                })
                .eq("id", featureTrace.spec_id);
            }

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

      // 4. Update the release trace itself
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
    // IMPORTANT: Update deployed_at to NOW so it appears as the most recent production
    const rollbackDeployedAt = new Date().toISOString();
    await ctx.db
      .from("specs")
      .update({
        release_status: "deployed",
        deployed_at: rollbackDeployedAt,
        updated_at: rollbackDeployedAt
      })
      .eq("id", targetSpec.id);

    // 5. Find the target release trace to get its release_pr_number
    const { data: targetReleaseTraces } = await ctx.db
      .from("release_traces")
      .select("id, release_pr_number, type, production_deployment")
      .eq("repo_full_name", repoFullName)
      .eq("type", "release")
      .in("status", ["rolled_back", "production_live", "merged_main", "completed"]);

    const targetReleaseTrace = targetReleaseTraces?.find((t: any) => {
      const prodDeploy = t.production_deployment as { releaseTag?: string; tag?: string } | null;
      return prodDeploy?.releaseTag === targetReleaseTag || prodDeploy?.tag === targetReleaseTag;
    });

    const targetReleasePrNumber = targetReleaseTrace?.release_pr_number ?? targetSpec.release_pr_number;

    // 6. Update any feature traces that were part of the target release back to production_live
    if (targetReleasePrNumber) {
      // Find feature traces with the same release_pr_number
      const { data: targetFeatureTraces } = await ctx.db
        .from("release_traces")
        .select("id, spec_id, title")
        .eq("repo_full_name", repoFullName)
        .eq("release_pr_number", targetReleasePrNumber)
        .eq("type", "feature")
        .in("status", ["rolled_back", "production_live", "merged_main", "completed"]);

      if (targetFeatureTraces?.length) {
        for (const featureTrace of targetFeatureTraces) {
          // Update trace status back to production_live
          await ctx.db
            .from("release_traces")
            .update({
              status: "production_live",
              updated_at: new Date().toISOString()
            })
            .eq("id", featureTrace.id);

          // Update linked spec if exists
          if (featureTrace.spec_id) {
            await ctx.db
              .from("specs")
              .update({
                release_status: "deployed",
                deployed_at: rollbackDeployedAt,
                updated_at: rollbackDeployedAt
              })
              .eq("id", featureTrace.spec_id);
          }

          // Add audit event for restored feature
          await ctx.db.from("trace_events").insert({
            trace_id: featureTrace.id,
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
 * Returns all releases that can be rolled back to (deployed or previously rolled back)
 * Excludes the current production version (from repos.current_version)
 */
export async function getAvailableReleases(
  ctx: ActionContext,
  repoFullName: string
): Promise<ActionResult<Array<{ releaseTag: string; deployedAt: string; specId: string; title: string; status: string }>>> {
  logAction("getAvailableReleases", ctx, { repoFullName });

  try {
    // Get canonical current version to exclude it from results
    const currentVersionData = await getRepoCurrentVersion(ctx.db, repoFullName);
    const currentReleaseTag = currentVersionData?.version ?? null;

    // Get all specs with valid release tags - include both deployed and rolled_back
    // so users can roll back to previously rolled back versions
    const { data: specs } = await ctx.db
      .from("specs")
      .select("id, release_tag, deployed_at, decomposed_tasks, release_status")
      .eq("repo_full_name", repoFullName)
      .in("release_status", ["deployed", "rolled_back"])
      .not("release_tag", "is", null)
      .order("deployed_at", { ascending: false })
      .limit(20);

    const releases = (specs || [])
      // Exclude current production version
      .filter(s => s.release_tag !== currentReleaseTag)
      .map(s => ({
        releaseTag: s.release_tag,
        deployedAt: s.deployed_at,
        specId: s.id,
        title: (s.decomposed_tasks as any)?.prTitle || `Release ${s.release_tag}`,
        status: s.release_status
      }));

    return success("Available releases retrieved.", releases);

  } catch (error) {
    logError("getAvailableReleases", ctx, error);
    return failure(`Failed to get available releases: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
