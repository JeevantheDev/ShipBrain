/**
 * Unified Action: Create Release PR
 *
 * Creates a release promotion PR from develop to main.
 * Used by: UI, AI Chat, Telegram
 */

import { createReleasePullRequest } from "@/lib/github/pr";
import { createOrUpdateTrace, associateFeaturesWithRelease } from "@/lib/orchestrator";
import { getNextSemverReleaseTag } from "@/lib/shipbrain/semver";
import {
  ActionContext,
  ActionResult,
  CreateReleasePRInput,
  CreateReleasePRResult,
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
 * Create a release PR from develop to main
 *
 * @param ctx - Action context with db, user, token
 * @param input - Create release PR input
 * @returns Action result with PR details
 */
export async function createReleasePR(
  ctx: ActionContext,
  input: CreateReleasePRInput
): Promise<ActionResult<CreateReleasePRResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("createReleasePR", ctx, { input });

  try {
    const repoFullName = input.repoFullName || ctx.repoFullName;
    if (!repoFullName?.includes("/")) {
      return failure("Repository name is required.");
    }

    const { owner, repo } = splitRepo(repoFullName);

    // Get the next semver release tag
    const releaseTag = input.releaseTag || await getNextSemverReleaseTag(ctx.db, repoFullName);

    logAction("createReleasePR:tag", ctx, { releaseTag });

    // Find merged specs that need to be included in this release
    const { data: mergedSpecs } = await ctx.db
      .from("specs")
      .select("id, decomposed_tasks, pr_number, pr_url, branch_name, raw_spec")
      .eq("repo_full_name", repoFullName)
      .eq("user_id", ctx.userId)
      .eq("status", "merged")
      .eq("base_branch", "develop")
      .is("release_pr_number", null)
      .order("merged_at", { ascending: false });

    // Build features section for PR body
    const getSpecTitle = (spec: any): string => {
      const tasks = spec.decomposed_tasks as { prTitle?: string } | null;
      if (tasks?.prTitle) return tasks.prTitle;
      if (spec.branch_name) return spec.branch_name.replace(/^(feature|fix|hotfix)\//, "").replace(/-/g, " ");
      return `PR #${spec.pr_number}`;
    };

    const featuresSection = mergedSpecs?.length
      ? [
          "### Features included in this release",
          "",
          ...mergedSpecs.map((s) => `- ${getSpecTitle(s)} ([#${s.pr_number}](${s.pr_url}))`),
          ""
        ].join("\n")
      : "";

    const prBody = [
      `## Release ${releaseTag}`,
      "",
      "This PR promotes the `develop` branch to `main` for production deployment.",
      "",
      featuresSection,
      "### Deployment Instructions",
      "",
      "1. Review the changes in this PR",
      "2. Merge this PR to main",
      "3. ShipBrain will automatically trigger production deployment",
      "",
      "---",
      "*Created by ShipBrain Release Manager*"
    ].join("\n");

    // Create the release PR
    const pr = await createReleasePullRequest({
      owner,
      repo,
      head: "develop",
      base: "main",
      releaseTag,
      body: prBody,
      token: ctx.githubToken
    });

    logAction("createReleasePR:prCreated", ctx, { prNumber: pr.number, prUrl: pr.html_url });

    // Create a spec for this release PR
    // IMPORTANT: Set release_pr_number so the webhook can find this spec when PR is merged
    const { data: releaseSpec, error: specError } = await ctx.db
      .from("specs")
      .insert({
        user_id: ctx.userId,
        repo_full_name: repoFullName,
        branch_name: "develop",
        base_branch: "main",
        pr_number: pr.number,
        pr_url: pr.html_url,
        status: "pending_pr",
        release_tag: releaseTag,
        release_status: "ready_for_prod",
        // Set release_pr_number so webhook can find this spec when merged
        release_pr_number: pr.number,
        release_pr_url: pr.html_url,
        release_pr_status: "open",
        decomposed_tasks: {
          type: "release",
          prTitle: `Release ${releaseTag}`,
          featuresIncluded: mergedSpecs?.map(s => s.pr_number) || []
        }
      })
      .select("id")
      .single();

    if (specError) {
      logError("createReleasePR:specInsert", ctx, specError);
    }

    // Link feature specs to this release
    const linkedSpecIds = mergedSpecs?.map(s => s.id) || [];
    if (linkedSpecIds.length > 0) {
      await ctx.db
        .from("specs")
        .update({
          release_pr_number: pr.number,
          release_pr_url: pr.html_url,
          release_pr_status: "open",
          release_tag: releaseTag,
          updated_at: new Date().toISOString()
        })
        .in("id", linkedSpecIds);

      // Associate features with release in orchestrator
      await associateFeaturesWithRelease(repoFullName, pr.number, pr.html_url, "open").catch(err =>
        logError("createReleasePR:associateFeatures", ctx, err)
      );
    }

    // Create or update release trace
    await createOrUpdateTrace({
      repoFullName,
      type: "release",
      title: `Release ${releaseTag}`,
      description: prBody,
      status: "release_pending",
      sourceBranch: "develop",
      targetBranch: "main",
      releasePrNumber: pr.number,
      releasePrUrl: pr.html_url,
      specId: releaseSpec?.id,
      source: ctx.source,
      actor: ctx.actor,
      eventType: "release_pr_created",
      details: {
        prNumber: pr.number,
        releaseTag,
        featuresIncluded: linkedSpecIds.length
      }
    }).catch(err => logError("createReleasePR:trace", ctx, err));

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "release_pr_created",
      title: "Release PR Created",
      body: `Release ${releaseTag} PR #${pr.number} is ready for review`,
      href: pr.html_url,
      severity: "info",
      repoFullName,
      metadata: { prNumber: pr.number, releaseTag, featuresIncluded: linkedSpecIds.length, source: ctx.source }
    });

    logAction("createReleasePR:success", ctx, {
      prNumber: pr.number,
      releaseTag,
      featuresIncluded: linkedSpecIds.length
    });

    return success(
      `Release PR #${pr.number} created for ${releaseTag} with ${linkedSpecIds.length} features.`,
      {
        prNumber: pr.number,
        prUrl: pr.html_url,
        releaseTag,
        releaseSha: "", // Will be set when PR is merged
        specId: releaseSpec?.id || "",
        featuresIncluded: linkedSpecIds.length
      },
      chainUpdates
    );

  } catch (error) {
    logError("createReleasePR", ctx, error);
    return failure(
      `Failed to create release PR: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
