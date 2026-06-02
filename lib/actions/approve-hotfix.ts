/**
 * Unified Action: Approve Hotfix
 *
 * Approves, merges, and deploys a hotfix PR.
 * Handles production deployment and reverse sync creation.
 * Used by: UI, AI Chat, Telegram
 */

import { dispatchDevelopPreviewDeploy, dispatchHotfixDeploy } from "@/lib/github/deployments";
import { listPullRequestCommits } from "@/lib/github/commits";
import { mergePullRequest, createReverseSyncPR, tagCommitForRelease } from "@/lib/github/pr";
import { createOrUpdateTrace, updateTraceByIncident } from "@/lib/orchestrator";
import { resolvePagerDutyIncident } from "@/lib/pagerduty/incidents";
import {
  ActionContext,
  ActionResult,
  ApproveHotfixInput,
  ApproveHotfixResult,
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

function hotfixReleaseTag(incidentId: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
  return `hotfix-v${date}-${incidentId.slice(0, 8)}`;
}

/**
 * Approve and merge a hotfix PR
 *
 * @param ctx - Action context with db, user, token
 * @param input - Approve hotfix input
 * @returns Action result with merge and deployment details
 */
export async function approveHotfix(
  ctx: ActionContext,
  input: ApproveHotfixInput
): Promise<ActionResult<ApproveHotfixResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("approveHotfix", ctx, { input });

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
      return failure("Create the incident hotfix Draft PR before approving the fix.");
    }

    if (!incident.repo_full_name?.includes("/")) {
      return failure("Incident is not linked to a connected GitHub repository.");
    }

    const { owner, repo } = splitRepo(incident.repo_full_name);

    // Get commits before merge
    const commits = await listPullRequestCommits({ owner, repo, pullNumber: incident.hotfix_pr_number });

    // Merge the PR
    const merge = await mergePullRequest({
      owner,
      repo,
      pullNumber: incident.hotfix_pr_number,
      commitTitle: `hotfix: resolve ${incident.title ?? incident.id}`,
      token: ctx.githubToken
    });

    const isProdDeploy = merge.baseBranch === "main";
    const releaseTag = input.releaseTag || hotfixReleaseTag(incident.id);

    let deployment: any = null;
    let deploymentError: string | null = null;

    try {
      if (isProdDeploy) {
        // Tag and deploy to production
        const release = await tagCommitForRelease({
          owner,
          repo,
          sha: merge.sha,
          releaseTag,
          token: ctx.githubToken
        });
        deployment = await dispatchHotfixDeploy({
          owner,
          repo,
          releaseTag: release.releaseTag,
          releaseSha: release.sha,
          reverseSync: true,
          token: ctx.githubToken
        });
      } else {
        // Deploy to preview/develop
        const { data: repoRow } = await ctx.db
          .from("repos")
          .select("default_branch")
          .eq("full_name", incident.repo_full_name)
          .single();
        const defaultBranch = repoRow?.default_branch || "main";

        deployment = await dispatchDevelopPreviewDeploy({
          owner,
          repo,
          ref: merge.baseBranch,
          defaultBranch,
          sourcePrNumber: incident.hotfix_pr_number,
          token: ctx.githubToken
        });
      }
    } catch (error) {
      deploymentError = error instanceof Error ? error.message : "Hotfix deployment dispatch failed.";
      logError("approveHotfix:deployment", ctx, error);
    }

    // Handle PagerDuty sync
    let pagerDutySyncStatus: string | null = incident.pagerduty_sync_status ?? null;
    let pagerDutySyncError: string | null = incident.pagerduty_sync_error ?? null;

    if (incident.alert_source === "pagerduty" && incident.external_id) {
      const pagerDutyResult = await resolvePagerDutyIncident({
        incidentId: incident.external_id,
        fromEmail: process.env.PAGERDUTY_FROM_EMAIL,
        note: [
          "ShipBrain approved and merged the incident hotfix.",
          `Hotfix PR: ${incident.hotfix_pr_url}`,
          `Merge SHA: ${merge.sha}`,
          incident.root_cause ? `Root cause: ${incident.root_cause}` : "",
          incident.ai_fix_proposal ? `Fix proposal: ${incident.ai_fix_proposal}` : ""
        ].filter(Boolean).join("\n\n")
      });
      if (!pagerDutyResult.ok) {
        pagerDutySyncStatus = "action_required";
        pagerDutySyncError = pagerDutyResult.detail ?? "The configured alert provider rejected the incident update.";
      } else {
        pagerDutySyncStatus = pagerDutyResult.skipped ? "skipped" : "resolved";
        pagerDutySyncError = pagerDutyResult.detail ?? null;
      }
    }

    // Create reverse sync PR if hotfix was merged to main
    let reverseSyncPr: Awaited<ReturnType<typeof createReverseSyncPR>> | null = null;
    let reverseSyncError: string | null = null;

    if (isProdDeploy) {
      try {
        reverseSyncPr = await createReverseSyncPR({
          owner,
          repo,
          sourceBranch: "main",
          targetBranch: "develop",
          incidentId: incident.id,
          incidentTitle: incident.title ?? "Incident fix",
          hotfixPrNumber: incident.hotfix_pr_number,
          releaseTag,
          token: ctx.githubToken
        });
      } catch (error) {
        reverseSyncError = error instanceof Error ? error.message : "Failed to create reverse sync PR";
        logError("approveHotfix:reverseSync", ctx, error);
      }
    }

    // Record approval event
    await ctx.db.from("approval_events").insert({
      entity_type: "incident",
      entity_id: incident.id,
      action: "fix_approved",
      actor_id: ctx.userId,
      note: input.note ?? null,
      metadata: {
        incidentTitle: incident.title,
        hotfixPrNumber: incident.hotfix_pr_number,
        hotfixPrUrl: incident.hotfix_pr_url,
        hotfixBranch: merge.headBranch,
        hotfixBaseBranch: merge.baseBranch,
        mergeSha: merge.sha,
        releaseTag: isProdDeploy ? releaseTag : null,
        pagerDutySyncStatus,
        reverseSyncPrNumber: reverseSyncPr?.number ?? null,
        reverseSyncPrUrl: reverseSyncPr?.html_url ?? null,
        deploymentDispatched: Boolean(deployment),
        source: ctx.source
      }
    });

    // Update incident
    const { error: updateError } = await ctx.db
      .from("incidents")
      .update({
        status: "investigating",
        hotfix_pr_status: "merged",
        hotfix_branch: merge.headBranch,
        hotfix_base_branch: merge.baseBranch,
        hotfix_merge_sha: merge.sha,
        hotfix_commits: commits,
        release_version: isProdDeploy ? releaseTag : null,
        fix_approved_at: new Date().toISOString(),
        pagerduty_sync_status: pagerDutySyncStatus,
        pagerduty_sync_error: pagerDutySyncError,
        reverse_sync_pr_number: reverseSyncPr?.number ?? null,
        reverse_sync_pr_url: reverseSyncPr?.html_url ?? null,
        reverse_sync_pr_status: reverseSyncPr ? "open" : null,
        reverse_sync_branch: isProdDeploy ? "develop" : null,
        reverse_sync_created_at: reverseSyncPr ? new Date().toISOString() : null,
        reverse_sync_error: reverseSyncError,
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", ctx.userId);

    if (updateError) {
      logError("approveHotfix:incidentUpdate", ctx, updateError);
    }

    // Update spec
    const specUpdate: Record<string, any> = {
      status: "merged",
      branch_name: merge.headBranch,
      base_branch: merge.baseBranch,
      merge_sha: merge.sha,
      feature_head_sha: merge.destinationSha,
      deployment_url: deployment?.workflowUrl ?? null,
      error_message: deploymentError,
      merged_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (isProdDeploy) {
      specUpdate.deployment_status = deployment ? "approved" : "not_requested";
      specUpdate.release_tag = releaseTag;
      specUpdate.release_sha = deployment ? merge.sha : null;
      specUpdate.release_status = deployment ? "deploying" : "failed";
    } else {
      specUpdate.deployment_status = deployment ? "develop_validated" : "not_requested";
      specUpdate.preview_status = deployment ? "deploying" : "failed";
    }

    await ctx.db
      .from("specs")
      .update(specUpdate)
      .eq("incident_id", incident.id);

    // Update release trace
    try {
      await createOrUpdateTrace({
        userId: ctx.userId,
        repoFullName: incident.repo_full_name,
        type: "hotfix",
        title: incident.title ?? `Incident ${incident.id.slice(0, 8)} hotfix`,
        description: incident.root_cause ?? incident.raw_logs ?? null,
        status: isProdDeploy ? "merged_main" : "merged_develop",
        sourceBranch: merge.headBranch,
        targetBranch: merge.baseBranch,
        draftPrNumber: incident.hotfix_pr_number,
        draftPrUrl: incident.hotfix_pr_url,
        incidentId: incident.id,
        source: ctx.source,
        actor: ctx.actor,
        eventType: "pr_merged",
        details: {
          hotfixPrNumber: incident.hotfix_pr_number,
          releaseTag: isProdDeploy ? releaseTag : null,
          deploymentDispatched: Boolean(deployment),
          deploymentWorkflowUrl: deployment?.workflowUrl ?? null
        }
      });

      if (isProdDeploy) {
        await updateTraceByIncident(incident.id, {
          status: deployment ? "merged_main" : "failed",
          production_deployment: {
            status: deployment ? "deploying" : "failed",
            tag: releaseTag,
            sha: merge.sha,
            workflowUrl: deployment?.workflowUrl ?? null,
            error: deploymentError
          },
          reverse_sync_pr_number: reverseSyncPr?.number ?? null,
          reverse_sync_pr_url: reverseSyncPr?.html_url ?? null,
          reverse_sync_status: reverseSyncPr ? "open" : reverseSyncError ? "failed" : null
        }, {
          eventType: reverseSyncPr ? "reverse_sync_created" : "deployment_started",
          source: ctx.source,
          actor: ctx.actor,
          details: {
            releaseTag,
            deploymentWorkflowUrl: deployment?.workflowUrl ?? null,
            reverseSyncPrNumber: reverseSyncPr?.number ?? null,
            reverseSyncPrUrl: reverseSyncPr?.html_url ?? null,
            reverseSyncError
          }
        });
      }
    } catch (traceError) {
      logError("approveHotfix:trace", ctx, traceError);
    }

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "hotfix_approved",
      title: "Hotfix Approved & Merged",
      body: `Hotfix for incident "${incident.title ?? incident.id.slice(0, 8)}" merged${isProdDeploy ? ` and deploying to production` : ""}`,
      href: deployment?.workflowUrl ?? incident.hotfix_pr_url,
      severity: isProdDeploy ? "warning" : "info",
      repoFullName: incident.repo_full_name,
      metadata: { incidentId: incident.id, mergeSha: merge.sha, releaseTag: isProdDeploy ? releaseTag : null, source: ctx.source }
    });

    logAction("approveHotfix:success", ctx, {
      incidentId: incident.id,
      merged: true,
      mergeSha: merge.sha,
      isProdDeploy,
      releaseTag: isProdDeploy ? releaseTag : null
    });

    return success(
      isProdDeploy
        ? `Hotfix merged and deploying to production with release ${releaseTag}.`
        : `Hotfix merged to ${merge.baseBranch} and preview deployment started.`,
      {
        incidentId: incident.id,
        merged: true,
        mergeSha: merge.sha,
        releaseTag: isProdDeploy ? releaseTag : null,
        workflowUrl: deployment?.workflowUrl ?? null,
        reverseSync: reverseSyncPr ? {
          prNumber: reverseSyncPr.number,
          prUrl: reverseSyncPr.html_url,
          created: reverseSyncPr.created
        } : null,
        isProdDeploy
      },
      chainUpdates
    );

  } catch (error) {
    logError("approveHotfix", ctx, error);
    return failure(
      `Failed to approve hotfix: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
