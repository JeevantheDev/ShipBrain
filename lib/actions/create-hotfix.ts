/**
 * Unified Action: Create Hotfix
 *
 * Creates a hotfix PR for an incident.
 * Used by: UI, AI Chat, Telegram
 */

import { createDraftPR } from "@/lib/github/pr";
import { listPullRequestCommits } from "@/lib/github/commits";
import { createOrUpdateTrace } from "@/lib/orchestrator";
import {
  ActionContext,
  ActionResult,
  CreateHotfixInput,
  CreateHotfixResult,
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

interface Incident {
  id: string;
  user_id: string;
  title: string | null;
  repo_full_name: string;
  release_version: string | null;
  root_cause: string | null;
  ai_fix_proposal: string | null;
  raw_logs: string | null;
  hotfix_pr_number: number | null;
  hotfix_pr_url: string | null;
  hotfix_branch: string | null;
  hotfix_base_branch: string | null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function renderHotfixHandoff(input: {
  incident: Incident;
  analysis: CreateHotfixInput["analysis"];
  releaseContext: unknown;
}): string {
  const commits = Array.isArray((input.releaseContext as any)?.commits?.featurePr)
    ? [
        ...((input.releaseContext as any)?.commits?.featurePr ?? []),
        ...((input.releaseContext as any)?.commits?.releasePr ?? [])
      ]
    : [];

  return [
    `# ShipBrain Incident Hotfix`,
    ``,
    `Incident: ${input.incident.title ?? input.incident.id}`,
    `Source release: ${input.incident.release_version ?? (input.releaseContext as any)?.release?.tag ?? "not captured"}`,
    `Repository: ${input.incident.repo_full_name}`,
    ``,
    `## AI analysis`,
    ``,
    `Root cause: ${input.analysis?.rootCause ?? "Pending developer verification."}`,
    ``,
    `Fix proposal: ${input.analysis?.fixProposal ?? "Pending developer implementation."}`,
    ``,
    `How it occurred: ${input.analysis?.changeSummary ?? "ShipBrain did not receive enough commit context to infer a precise path."}`,
    ``,
    `## Related release commits`,
    commits.length
      ? commits.map((commit: any) => `- ${commit.shortSha ?? commit.sha?.slice(0, 7)} ${commit.message}`).join("\n")
      : `- No linked release commits were found.`,
    ``,
    `## Developer instructions`,
    ``,
    `1. Implement the fix on this hotfix branch.`,
    `2. Keep commits focused and descriptive; ShipBrain will re-read this PR before manager approval.`,
    `3. When the PR is reviewed, approve the incident fix in ShipBrain to merge this PR and trigger CI.`,
    ``,
    `ShipBrain-codegen: incident-hotfix-handoff-only`
  ].filter(Boolean).join("\n");
}

/**
 * Create a hotfix PR for an incident
 *
 * @param ctx - Action context with db, user, token
 * @param input - Create hotfix input
 * @returns Action result with PR details
 */
export async function createHotfix(
  ctx: ActionContext,
  input: CreateHotfixInput
): Promise<ActionResult<CreateHotfixResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("createHotfix", ctx, { input });

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

    if (!incident.repo_full_name?.includes("/")) {
      return failure("Incident is not linked to a connected GitHub repository.");
    }

    // Already has hotfix PR?
    if (incident.hotfix_pr_number) {
      return success(
        `Hotfix PR #${incident.hotfix_pr_number} already exists for this incident.`,
        {
          incidentId: incident.id,
          specId: "",
          prNumber: incident.hotfix_pr_number,
          prUrl: incident.hotfix_pr_url ?? "",
          branch: incident.hotfix_branch ?? "",
          baseBranch: incident.hotfix_base_branch ?? "develop",
          commits: []
        },
        chainUpdates
      );
    }

    const { owner, repo } = splitRepo(incident.repo_full_name);
    const titleSlug = slugify(incident.title ?? "incident-fix");
    const branch = `hotfix/incident-${incident.id.slice(0, 8)}-${titleSlug || "fix"}`;
    const baseBranch = input.baseBranch ?? "develop";
    const analysis = input.analysis ?? {};
    const releaseContext = analysis.releaseContext ?? null;

    const handoff = renderHotfixHandoff({ incident, analysis, releaseContext });

    const prTitle = `hotfix: ${incident.title ?? "incident fix"}`;
    const prBody = [
      `## ShipBrain incident hotfix`,
      ``,
      `Incident: \`${incident.id}\``,
      `Release: \`${incident.release_version ?? (releaseContext as any)?.release?.tag ?? "not captured"}\``,
      ``,
      `### AI root cause`,
      analysis.rootCause ?? "Pending analysis.",
      ``,
      `### Fix direction`,
      analysis.fixProposal ?? "Pending developer implementation.",
      ``,
      `### Manager approval expectation`,
      `After the developer pushes the fix commits, ShipBrain will show the PR commit list in Incident Commander before approval. Approval merges this PR into \`${baseBranch}\` and lets CI run from GitHub.`
    ].filter(Boolean).join("\n");

    // Create draft PR
    const pr = await createDraftPR({
      owner,
      repo,
      base: baseBranch,
      branch,
      title: prTitle,
      body: prBody,
      files: {
        "SHIPBRAIN_INCIDENT_HOTFIX.md": handoff
      },
      token: ctx.githubToken
    });

    logAction("createHotfix:prCreated", ctx, { prNumber: pr.number, prUrl: pr.html_url });

    // Create spec for tracking
    const { data: spec, error: specError } = await ctx.db
      .from("specs")
      .insert({
        user_id: ctx.userId,
        raw_spec: handoff,
        repo_full_name: incident.repo_full_name,
        branch_name: branch,
        base_branch: baseBranch,
        pr_number: pr.number,
        pr_url: pr.html_url,
        status: "draft_created",
        incident_id: incident.id,
        updated_at: new Date().toISOString()
      })
      .select("id")
      .single();

    if (specError) {
      logError("createHotfix:specInsert", ctx, specError);
      return failure("Hotfix PR was created, but ShipBrain could not save its tracker.");
    }

    // Get initial commits
    const commits = await listPullRequestCommits({ owner, repo, pullNumber: pr.number }).catch(() => []);

    // Update incident
    const { error: updateError } = await ctx.db
      .from("incidents")
      .update({
        status: "investigating",
        root_cause: analysis.rootCause ?? incident.root_cause,
        ai_fix_proposal: analysis.fixProposal ?? incident.ai_fix_proposal,
        ai_analysis: analysis,
        hotfix_branch: branch,
        hotfix_base_branch: baseBranch,
        hotfix_pr_number: pr.number,
        hotfix_pr_url: pr.html_url,
        hotfix_pr_status: "draft_created",
        hotfix_commits: commits,
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", ctx.userId);

    if (updateError) {
      logError("createHotfix:incidentUpdate", ctx, updateError);
    }

    // Create release trace
    await createOrUpdateTrace({
      userId: ctx.userId,
      repoFullName: incident.repo_full_name,
      type: "hotfix",
      title: incident.title ?? `Incident ${incident.id.slice(0, 8)} hotfix`,
      description: incident.root_cause ?? incident.raw_logs ?? null,
      status: "draft",
      sourceBranch: branch,
      targetBranch: baseBranch,
      draftPrNumber: pr.number,
      draftPrUrl: pr.html_url,
      specId: spec.id,
      incidentId: incident.id,
      source: ctx.source,
      actor: ctx.actor,
      eventType: "hotfix_created",
      details: {
        incidentId: incident.id,
        incidentTitle: incident.title,
        prNumber: pr.number,
        branch,
        baseBranch,
        source: ctx.source
      }
    }).catch(err => logError("createHotfix:trace", ctx, err));

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "hotfix_created",
      title: "Hotfix PR Created",
      body: `Created hotfix PR #${pr.number} for incident: ${incident.title ?? incident.id.slice(0, 8)}`,
      href: pr.html_url,
      severity: "warning",
      repoFullName: incident.repo_full_name,
      metadata: { incidentId: incident.id, prNumber: pr.number, branch, source: ctx.source }
    });

    logAction("createHotfix:success", ctx, {
      incidentId: incident.id,
      specId: spec.id,
      prNumber: pr.number
    });

    return success(
      `Hotfix PR #${pr.number} created. Implement the fix and then approve to merge and deploy.`,
      {
        incidentId: incident.id,
        specId: spec.id,
        prNumber: pr.number,
        prUrl: pr.html_url,
        branch,
        baseBranch,
        commits: commits.map((c: any) => ({ sha: c.sha, message: c.message }))
      },
      chainUpdates
    );

  } catch (error) {
    logError("createHotfix", ctx, error);
    return failure(
      `Failed to create hotfix PR: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
