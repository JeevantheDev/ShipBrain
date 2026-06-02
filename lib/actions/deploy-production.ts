/**
 * Unified Action: Deploy Production
 *
 * Deploys to production environment with release tag.
 * Handles: Release promotion, hotfixes, onboarding, redeployment
 * Used by: UI, AI Chat, Telegram
 */

import { getOctokit } from "@/lib/github/client";
import { dispatchHotfixDeploy, dispatchCloudflareProductionDeploy, createReleaseTag } from "@/lib/github/deployments";
import { updateTraceBySpec } from "@/lib/orchestrator";
import {
  ActionContext,
  ActionResult,
  DeployProductionInput,
  DeployProductionResult,
  ChainUpdate,
  Spec
} from "./types";
import {
  logAction,
  logError,
  splitRepo,
  getSpecById,
  updateSpec,
  updateLinkedSpecs,
  createNotification,
  success,
  failure
} from "./utils";

/**
 * Deploy to production environment
 *
 * @param ctx - Action context with db, user, token
 * @param input - Deploy production input
 * @returns Action result with deployment details
 */
export async function deployProduction(
  ctx: ActionContext,
  input: DeployProductionInput
): Promise<ActionResult<DeployProductionResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("deployProduction", ctx, { input });

  try {
    // Get spec
    let spec: Spec | null = null;

    if (input.specId) {
      spec = await getSpecById(ctx.db, input.specId);
    } else if (input.repoFullName && input.releaseTag) {
      // Find spec by release tag
      const { data } = await ctx.db
        .from("specs")
        .select("*")
        .eq("repo_full_name", input.repoFullName)
        .eq("release_tag", input.releaseTag)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      spec = data;
    }

    if (!spec) {
      return failure("Spec not found.");
    }

    // Verify ownership
    if (spec.user_id !== ctx.userId) {
      return failure("You don't have permission to deploy this spec.");
    }

    const releaseTag = input.releaseTag || spec.release_tag;
    if (!releaseTag) {
      return failure("Release tag is required for production deployment.");
    }

    // Determine spec type
    const isOnboarding = (spec.decomposed_tasks as any)?.type === "onboarding";
    const isMergedReleasePromotion = spec.status === "merged" && spec.branch_name === "develop" && spec.base_branch === "main";
    const isMergedDirectMainHotfix = spec.status === "merged" && spec.base_branch === "main" &&
      typeof spec.branch_name === "string" && spec.branch_name.startsWith("hotfix/");
    const isPendingDeploy = spec.release_status === "pending_deploy" && spec.release_pr_status === "merged";
    const isFeatureMergedToDevelop = spec.status === "merged" && spec.base_branch === "develop";
    const forceRedeploy = (input as any).forceRedeploy === true;

    // Already deployed?
    if (spec.release_status === "deployed" && !forceRedeploy) {
      return failure(
        `Production is already deployed with release ${spec.release_tag}. Use forceRedeploy option to redeploy.`
      );
    }

    // Currently deploying?
    if (spec.release_status === "deploying" && !forceRedeploy) {
      return failure(`Production deployment for ${spec.release_tag} is already in progress.`);
    }

    // Feature merged to develop - check release PR
    if (isFeatureMergedToDevelop && !isOnboarding) {
      if (!spec.release_pr_number) {
        return failure(
          "No release PR exists yet. Create a Release PR (develop → main) first, then merge it before deploying to production."
        );
      }
      if (spec.release_pr_status !== "merged") {
        return failure(
          `Release PR #${spec.release_pr_number} is not merged yet. Please merge it on GitHub first.`
        );
      }
    }

    // Validate readiness
    if (!isPendingDeploy && !isMergedReleasePromotion && !isMergedDirectMainHotfix && !isOnboarding && !forceRedeploy) {
      return failure(
        `Spec is not ready for production deployment. Current release_status: ${spec.release_status}. ` +
        (spec.base_branch === "develop"
          ? "Create and merge a Release PR (develop → main) first."
          : "Ensure the spec is properly merged to main.")
      );
    }

    const { owner, repo } = splitRepo(spec.repo_full_name);
    let releaseSha = input.releaseSha || spec.release_sha || spec.merge_sha;

    // Try to get SHA from PR if not available
    if (!releaseSha && isMergedReleasePromotion && spec.pr_number) {
      try {
        const octokit = getOctokit(ctx.githubToken);
        const { data: pull } = await octokit.pulls.get({
          owner,
          repo,
          pull_number: spec.pr_number
        });
        releaseSha = pull.merge_commit_sha ?? null;
      } catch {
        // Fall back to main HEAD below
      }
    }

    // Fall back to main HEAD
    if (!releaseSha && (isMergedReleasePromotion || isMergedDirectMainHotfix)) {
      try {
        const octokit = getOctokit(ctx.githubToken);
        const { data: ref } = await octokit.git.getRef({
          owner,
          repo,
          ref: "heads/main"
        });
        releaseSha = ref.object.sha;
      } catch {
        // Let the error below explain
      }
    }

    if (!releaseSha) {
      return failure("No release SHA available. The release PR merge commit SHA is required.");
    }

    // Resolve short SHA to full SHA
    if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
      try {
        const octokit = getOctokit(ctx.githubToken);
        const { data: commit } = await octokit.git.getCommit({
          owner,
          repo,
          commit_sha: releaseSha
        });
        releaseSha = commit.sha;
      } catch {
        try {
          const octokit = getOctokit(ctx.githubToken);
          const { data: ref } = await octokit.git.getRef({
            owner,
            repo,
            ref: "heads/main"
          });
          releaseSha = ref.object.sha;
        } catch {
          return failure(`Unable to resolve short SHA "${releaseSha}" to full SHA.`);
        }
      }
    }

    logAction("deployProduction:dispatch", ctx, { releaseTag, releaseSha, isHotfix: isMergedDirectMainHotfix });

    // Create release tag if needed
    if (!spec.release_tag || spec.release_tag !== releaseTag) {
      await createReleaseTag({
        owner,
        repo,
        tag: releaseTag,
        sha: releaseSha,
        message: `Production release created by ShipBrain`,
        token: ctx.githubToken
      });
    }

    // Dispatch production workflow
    const deployment = isMergedDirectMainHotfix
      ? await dispatchHotfixDeploy({
          owner,
          repo,
          releaseTag,
          releaseSha,
          reverseSync: true,
          token: ctx.githubToken
        })
      : await dispatchCloudflareProductionDeploy({
          owner,
          repo,
          releaseTag,
          releaseSha,
          token: ctx.githubToken
        });

    // Update spec
    await updateSpec(ctx.db, spec.id, {
      release_tag: releaseTag,
      release_sha: releaseSha,
      release_status: "deploying",
      release_pr_status: "merged",
      deployment_status: "deploying"
    } as any, chainUpdates);

    // Update all linked feature specs
    let linkedSpecsUpdated = 0;
    if (spec.release_pr_number) {
      linkedSpecsUpdated = await updateLinkedSpecs(
        ctx.db,
        spec.repo_full_name,
        null,
        spec.release_pr_number,
        {
          release_tag: releaseTag,
          release_sha: releaseSha,
          release_status: "deploying"
        } as any,
        spec.id
      );
    }

    // Update incident if hotfix
    if (isMergedDirectMainHotfix && spec.incident_id) {
      await ctx.db
        .from("incidents")
        .update({
          release_version: releaseTag,
          updated_at: new Date().toISOString()
        })
        .eq("id", spec.incident_id);
    }

    // Update release trace
    await updateTraceBySpec(spec.id, {
      status: "merged_main",
      production_deployment: {
        status: "deploying",
        tag: releaseTag,
        releaseTag,
        sha: releaseSha,
        url: deployment.workflowUrl,
        runUrl: deployment.workflowUrl,
        timestamp: new Date().toISOString()
      }
    }, {
      eventType: "deployment_started",
      source: ctx.source,
      actor: ctx.actor,
      actorType: ctx.source === "system" || ctx.source === "webhook" ? "system" : "user",
      details: {
        specId: spec.id,
        repo: spec.repo_full_name,
        releaseTag,
        releaseSha,
        workflowUrl: deployment.workflowUrl,
        source: ctx.source
      }
    }).catch((err) => logError("deployProduction:updateTrace", ctx, err));

    // Record approval event
    await ctx.db.from("approval_events").insert({
      entity_type: "spec",
      entity_id: spec.id,
      action: "deploy_approved",
      actor_id: ctx.userId,
      note: `Started production deployment from ${ctx.source}`,
      metadata: {
        specId: spec.id,
        repo: spec.repo_full_name,
        releaseTag,
        releaseSha,
        workflowUrl: deployment.workflowUrl,
        source: ctx.source
      }
    });

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "production_deploy_started",
      title: "Production Deployment Started",
      body: `Deploying ${releaseTag} to production`,
      href: deployment.workflowUrl,
      severity: "warning",
      repoFullName: spec.repo_full_name,
      metadata: { specId: spec.id, releaseTag, releaseSha, source: ctx.source }
    });

    logAction("deployProduction:success", ctx, {
      specId: spec.id,
      releaseTag,
      releaseSha,
      workflowUrl: deployment.workflowUrl,
      linkedSpecsUpdated
    });

    return success(
      "Production deployment started. The release will be live after the workflow completes.",
      {
        specId: spec.id,
        releaseTag,
        releaseSha,
        workflowUrl: deployment.workflowUrl,
        productionUrl: null,
        status: "deploying",
        linkedSpecsUpdated
      },
      chainUpdates
    );

  } catch (error) {
    logError("deployProduction", ctx, error);
    return failure(
      `Failed to start production deployment: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
