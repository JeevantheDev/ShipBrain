/**
 * Unified Action: Deploy Preview
 *
 * Deploys merged changes to the preview (develop) environment.
 * Used by: UI, AI Chat, Telegram
 */

import { getOctokit } from "@/lib/github/client";
import { dispatchDevelopPreviewDeploy } from "@/lib/github/deployments";
import { updateTraceBySpec } from "@/lib/orchestrator";
import {
  ActionContext,
  ActionResult,
  DeployPreviewInput,
  DeployPreviewResult,
  ChainUpdate,
  Spec
} from "./types";
import {
  logAction,
  logError,
  splitRepo,
  getSpecById,
  updateSpec,
  createNotification,
  success,
  failure
} from "./utils";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findDispatchedPreviewRun(input: {
  token: string;
  owner: string;
  repo: string;
  workflowId: string;
  dispatchedAfter: number;
  defaultBranch: string;
}) {
  const octokit = getOctokit(input.token);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await wait(900);
    const { data } = await octokit.actions.listWorkflowRuns({
      owner: input.owner,
      repo: input.repo,
      workflow_id: input.workflowId,
      event: "workflow_dispatch",
      per_page: 10
    });

    const run = (data.workflow_runs ?? []).find((workflowRun: any) => {
      const createdAt = new Date(workflowRun.created_at ?? workflowRun.run_started_at ?? 0).getTime();
      return createdAt >= input.dispatchedAfter - 5000 &&
        (!workflowRun.head_branch || workflowRun.head_branch === input.defaultBranch || workflowRun.head_branch === "develop");
    });

    if (run) return run;
  }

  return null;
}

/**
 * Deploy to preview environment
 *
 * @param ctx - Action context with db, user, token
 * @param input - Deploy preview input
 * @returns Action result with deployment details
 */
export async function deployPreview(
  ctx: ActionContext,
  input: DeployPreviewInput
): Promise<ActionResult<DeployPreviewResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("deployPreview", ctx, { input });

  try {
    // Get spec
    let spec: Spec | null = null;

    if (input.specId) {
      spec = await getSpecById(ctx.db, input.specId);
    } else if (input.repoFullName) {
      // Find latest merged spec for this repo that needs preview
      const { data } = await ctx.db
        .from("specs")
        .select("*")
        .eq("repo_full_name", input.repoFullName)
        .eq("user_id", ctx.userId)
        .eq("status", "merged")
        .eq("base_branch", "develop")
        .is("preview_url", null)
        .order("merged_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      spec = data;
    }

    if (!spec) {
      return failure("Spec not found or no specs need preview deployment.");
    }

    // Validate spec state
    if (spec.status !== "merged") {
      return failure(`Spec must be merged before preview deployment. Current status: ${spec.status}`);
    }

    if (spec.base_branch !== "develop") {
      return failure(`Preview deployment is only for PRs merged to develop. Base branch: ${spec.base_branch}`);
    }

    if (spec.preview_status === "deploying") {
      return failure("Preview deployment is already in progress.");
    }

    // Allow redeploy if forceRedeploy is set, otherwise block if already deployed
    const isRedeploy = Boolean(spec.preview_url && input.forceRedeploy);
    if (spec.preview_url && !input.forceRedeploy) {
      return failure(`Preview is already deployed: ${spec.preview_url}. Use "redeploy preview" to force a new deployment.`);
    }

    const { owner, repo } = splitRepo(spec.repo_full_name);
    const dispatchedAfter = Date.now();

    if (isRedeploy) {
      logAction("deployPreview:redeploy", ctx, { specId: spec.id, previousUrl: spec.preview_url });
    }

    // Get repo default branch
    const { data: repoRow } = await ctx.db
      .from("repos")
      .select("default_branch")
      .eq("full_name", spec.repo_full_name)
      .single();

    const defaultBranch = repoRow?.default_branch || "main";
    const targetBranch = spec.base_branch || "develop";

    // Dispatch the preview workflow
    logAction("deployPreview:dispatch", ctx, { targetBranch, defaultBranch });

    const deployment = await dispatchDevelopPreviewDeploy({
      owner,
      repo,
      ref: targetBranch,
      defaultBranch,
      sourcePrNumber: spec.pr_number,
      token: ctx.githubToken,
      noFallback: true
    });

    // Try to find the dispatched workflow run
    const workflowRun = await findDispatchedPreviewRun({
      token: ctx.githubToken,
      owner,
      repo,
      workflowId: deployment.workflowId,
      dispatchedAfter,
      defaultBranch
    });

    // Update spec status
    await updateSpec(ctx.db, spec.id, {
      deployment_status: "develop_validated",
      preview_status: "deploying",
      latest_ci_run_id: workflowRun?.id ?? null,
      ci_status: workflowRun?.status ?? "queued",
      ci_conclusion: workflowRun?.conclusion ?? null,
      feature_last_synced_at: new Date().toISOString()
    } as any, chainUpdates);

    // Record CI run
    if (workflowRun?.id) {
      await ctx.db
        .from("ci_runs")
        .upsert(
          {
            github_run_id: workflowRun.id,
            spec_id: spec.id,
            pr_number: spec.pr_number ?? null,
            repo_full_name: spec.repo_full_name,
            workflow_name: workflowRun.name ?? deployment.workflowId,
            title: workflowRun.display_title ?? workflowRun.name ?? `Workflow run #${workflowRun.id}`,
            html_url: workflowRun.html_url ?? null,
            head_sha: workflowRun.head_sha ?? spec.merge_sha ?? null,
            event: workflowRun.event ?? "workflow_dispatch",
            branch: deployment.ref,
            environment: "preview",
            status: workflowRun.status ?? "queued",
            conclusion: workflowRun.conclusion ?? null,
            updated_at: new Date().toISOString()
          },
          { onConflict: "github_run_id" }
        );
    }

    // Record approval event
    await ctx.db.from("approval_events").insert({
      entity_type: "spec",
      entity_id: spec.id,
      action: "deploy_approved",
      actor_id: ctx.userId,
      note: `Started preview deployment from ${ctx.source}`,
      metadata: {
        specId: spec.id,
        repo: spec.repo_full_name,
        branch: "develop",
        prNumber: spec.pr_number,
        workflowUrl: deployment.workflowUrl,
        source: ctx.source,
        approvedFor: "develop preview deployment"
      }
    });

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "preview_deploy_started",
      title: isRedeploy ? "Preview Redeployment Started" : "Preview Deployment Started",
      body: `${isRedeploy ? "Redeploying" : "Deploying"} PR #${spec.pr_number} to preview environment`,
      href: deployment.workflowUrl,
      severity: "info",
      repoFullName: spec.repo_full_name,
      metadata: { specId: spec.id, prNumber: spec.pr_number, branch: "develop", source: ctx.source, isRedeploy }
    });

    // Update release trace
    await updateTraceBySpec(spec.id, {
      status: "merged_develop",
      current_phase: "preview",
      preview_deployment: {
        status: "deploying",
        url: deployment.workflowUrl,
        branch: "develop",
        timestamp: new Date().toISOString()
      }
    }, {
      eventType: "preview_deploy_started",
      source: ctx.source,
      actor: ctx.actor,
      actorType: ctx.source === "system" || ctx.source === "webhook" ? "system" : "user",
      details: {
        specId: spec.id,
        prNumber: spec.pr_number,
        workflowUrl: deployment.workflowUrl
      }
    }).catch((err) => logError("deployPreview:updateTrace", ctx, err));

    logAction("deployPreview:success", ctx, {
      specId: spec.id,
      workflowUrl: deployment.workflowUrl,
      workflowRunId: workflowRun?.id
    });

    const successMessage = isRedeploy
      ? "Preview redeployment started. The preview will be updated after the workflow completes."
      : "Preview deployment started. The preview URL will appear after the workflow completes.";

    return success(
      successMessage,
      {
        specId: spec.id,
        workflowUrl: deployment.workflowUrl,
        previewUrl: isRedeploy ? spec.preview_url : null,
        status: "deploying",
        isRedeploy
      },
      chainUpdates
    );

  } catch (error) {
    logError("deployPreview", ctx, error);
    return failure(
      `Failed to start preview deployment: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
