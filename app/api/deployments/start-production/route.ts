import { NextResponse } from "next/server";
import { dispatchHotfixDeploy, dispatchVercelProductionDeploy, createReleaseTag } from "@/lib/github/deployments";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOctokit } from "@/lib/github/client";
import { updateTraceBySpec } from "@/lib/orchestrator";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

function generateReleaseTag() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
  const time = now.toISOString().slice(11, 16).replace(":", "");
  return `release-v${date}-${time}`;
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user: authUser }
  } = await supabase.auth.getUser();

  const body = await request.json();

  // Support internal server-to-server calls with internalUserId
  const internalUserId = body.internalUserId || request.headers.get("X-Internal-User-Id");
  const user = authUser || (internalUserId ? { id: internalUserId, email: null } : null);
  const isInternalCall = !authUser && !!internalUserId;

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const specId = String(body.specId ?? "");
  const requestedReleaseTag = String(body.releaseTag ?? "").trim();
  if (!specId) {
    return NextResponse.json({ error: "specId is required" }, { status: 400 });
  }
  if (!requestedReleaseTag) {
    return NextResponse.json(
      { error: "Release tag is required.", detail: "Confirm or edit the release tag in the Deploy to Production modal before starting deployment." },
      { status: 400 }
    );
  }

  // Use admin client for internal calls to bypass RLS
  const db = isInternalCall ? getSupabaseAdminClient() : supabase;

  const { data: spec, error: specError } = await db
    .from("specs")
    .select("id, status, repo_full_name, branch_name, base_branch, pr_number, merge_sha, release_status, release_pr_number, release_pr_url, release_pr_status, release_tag, release_sha, incident_id, decomposed_tasks")
    .eq("id", specId)
    .eq("user_id", user.id)
    .single();

  if (specError || !spec) {
    return NextResponse.json({ error: "Spec not found.", detail: specError?.message }, { status: 404 });
  }

  // Check if this is an onboarding spec (initial deployment)
  const isOnboarding = (spec.decomposed_tasks as any)?.type === "onboarding";
  const forceRedeploy = body.forceRedeploy === true;

  const isMergedReleasePromotion = spec.status === "merged" && spec.branch_name === "develop" && spec.base_branch === "main";
  const isMergedDirectMainHotfix =
    spec.status === "merged" &&
    spec.base_branch === "main" &&
    typeof spec.branch_name === "string" &&
    spec.branch_name.startsWith("hotfix/");
  const isPendingDeploy = spec.release_status === "pending_deploy" && spec.release_pr_status === "merged";
  const isFeatureMergedToDevelop = spec.status === "merged" && spec.base_branch === "develop";

  // Check if already deployed - offer redeploy option
  if (spec.release_status === "deployed" && !forceRedeploy) {
    return NextResponse.json(
      {
        error: "Production is already deployed.",
        detail: `Release ${spec.release_tag || "unknown"} is already deployed. To redeploy, say "redeploy production" or use forceRedeploy option.`,
        action: "redeploy_production",
        currentReleaseTag: spec.release_tag
      },
      { status: 409 }
    );
  }

  // Check if currently deploying - offer to wait or force
  if (spec.release_status === "deploying" && !forceRedeploy) {
    return NextResponse.json(
      {
        error: "Production deployment is already in progress.",
        detail: `Deployment for ${spec.release_tag || "unknown"} is in progress. Wait for it to complete or say "redeploy production" to force a new deployment.`,
        action: "wait_or_redeploy"
      },
      { status: 409 }
    );
  }

  // Smart guidance based on current state
  if (isFeatureMergedToDevelop) {
    // Feature merged to develop - check release PR status
    if (!spec.release_pr_number) {
      return NextResponse.json(
        {
          error: "No release PR exists yet.",
          detail: "Create a Release PR (develop → main) first from the Deployment Queue, then merge it before deploying to production.",
          action: "create_release_pr"
        },
        { status: 409 }
      );
    }
    if (spec.release_pr_status !== "merged") {
      return NextResponse.json(
        {
          error: "Release PR is not merged yet.",
          detail: `Please review and merge Release PR #${spec.release_pr_number} on GitHub first, then try again.`,
          action: "merge_release_pr",
          releasePrNumber: spec.release_pr_number,
          releasePrUrl: spec.release_pr_url
        },
        { status: 409 }
      );
    }
  }

  // Onboarding specs are always ready for production deployment (they represent the initial setup)
  if (!isPendingDeploy && !isMergedReleasePromotion && !isMergedDirectMainHotfix && !isOnboarding && !forceRedeploy) {
    return NextResponse.json(
      {
        error: "Spec is not ready for production deployment.",
        detail: `Current release_status: ${spec.release_status}. ` +
          (spec.base_branch === "develop"
            ? "Create and merge a Release PR (develop → main) first."
            : "Ensure the spec is properly merged to main."),
        action: spec.base_branch === "develop" ? "create_release_pr" : undefined
      },
      { status: 409 }
    );
  }

  // Skip release PR check for onboarding specs and force redeploys
  if (!isMergedReleasePromotion && !isMergedDirectMainHotfix && !isOnboarding && !forceRedeploy && spec.release_pr_status !== "merged") {
    return NextResponse.json(
      { error: "Release PR must be merged before deploying to production.", detail: `Current release_pr_status: ${spec.release_pr_status}` },
      { status: 409 }
    );
  }

  const { owner, repo } = splitRepo(spec.repo_full_name);
  const releaseTag = requestedReleaseTag;
  let releaseSha = spec.release_sha || spec.merge_sha;

  if (!releaseSha && isMergedReleasePromotion && spec.pr_number) {
    try {
      const octokit = getOctokit();
      const { data: pull } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: spec.pr_number
      });
      releaseSha = pull.merge_commit_sha ?? undefined;
    } catch {
      // Fall back to main HEAD below.
    }
  }

  if (!releaseSha && (isMergedReleasePromotion || isMergedDirectMainHotfix)) {
    try {
      const octokit = getOctokit();
      const { data: ref } = await octokit.git.getRef({
        owner,
        repo,
        ref: "heads/main"
      });
      releaseSha = ref.object.sha;
    } catch {
      // Let the explicit missing-SHA response below explain the issue.
    }
  }

  if (!releaseSha) {
    return NextResponse.json(
      { error: "No release SHA available. The release PR merge commit SHA is required.", detail: "Please ensure the release PR was properly merged. Try refreshing the page." },
      { status: 409 }
    );
  }

  // If SHA is short (not 40 chars), try to resolve the full SHA from GitHub
  if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
    try {
      const octokit = getOctokit();
      const { data: commit } = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: releaseSha
      });
      releaseSha = commit.sha;

      // Update the spec with the full SHA for future use
      await db
        .from("specs")
        .update({ release_sha: releaseSha, updated_at: new Date().toISOString() })
        .eq("id", spec.id);
    } catch (resolveError) {
      // If we can't resolve, try getting the latest commit on main
      try {
        const octokit = getOctokit();
        const { data: ref } = await octokit.git.getRef({
          owner,
          repo,
          ref: "heads/main"
        });
        releaseSha = ref.object.sha;

        // Update the spec with the full SHA
        await db
          .from("specs")
          .update({ release_sha: releaseSha, updated_at: new Date().toISOString() })
          .eq("id", spec.id);
      } catch {
        return NextResponse.json(
          { error: "Unable to resolve full SHA.", detail: `Short SHA "${releaseSha}" could not be resolved to a full 40-character SHA.` },
          { status: 409 }
        );
      }
    }
  }

  try {
    // Create the requested/default release tag when it differs from the stored tag.
    // This keeps the DB, Git tag, and dispatched workflow ref aligned with the
    // manager-confirmed release tag from CI Monitor.
    if (!spec.release_tag || spec.release_tag !== releaseTag) {
      await createReleaseTag({
        owner,
        repo,
        tag: releaseTag,
        sha: releaseSha,
        message: `Production release created by ShipBrain`
      });
    }

    // Dispatch production deploy workflow. Direct main hotfixes must carry the
    // hotfix flags so the repo workflow opens the main -> develop reverse-sync PR.
    const deployment = isMergedDirectMainHotfix
      ? await dispatchHotfixDeploy({
          owner,
          repo,
          releaseTag,
          releaseSha,
          reverseSync: true
        })
      : await dispatchVercelProductionDeploy({
          owner,
          repo,
          releaseTag,
          releaseSha
        });

    // Update spec with deployment info
    await db
      .from("specs")
      .update({
        release_tag: releaseTag,
        release_sha: releaseSha,
        release_status: "deploying",
        release_pr_status: "merged",
        deployment_status: "deploying",
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);

    // Also update all feature specs associated with this release PR
    // This ensures they all get marked as deploying and can be found by webhooks
    if (spec.release_pr_number) {
      await db
        .from("specs")
        .update({
          release_tag: releaseTag,
          release_sha: releaseSha,
          release_status: "deploying",
          updated_at: new Date().toISOString()
        })
        .eq("repo_full_name", spec.repo_full_name)
        .eq("release_pr_number", spec.release_pr_number)
        .neq("id", spec.id);
    }

    if (isMergedDirectMainHotfix && spec.incident_id) {
      await db
        .from("incidents")
        .update({
          release_version: releaseTag,
          updated_at: new Date().toISOString()
        })
        .eq("id", spec.incident_id)
        .eq("user_id", user.id);
    }

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
      source: "manual",
      actor: user.email ?? user.id,
      actorType: "user",
      details: {
        specId: spec.id,
        repo: spec.repo_full_name,
        releaseTag,
        releaseSha,
        workflowUrl: deployment.workflowUrl,
        approvedFor: "production deployment"
      }
    }).catch(() => null);

    // Record approval event
    await db.from("approval_events").insert({
      entity_type: "spec",
      entity_id: spec.id,
      action: "deploy_approved",
      actor_id: user.id,
      note: "Started production deployment from Deployment Queue",
      metadata: {
        specId: spec.id,
        repo: spec.repo_full_name,
        releaseTag,
        releaseSha,
        workflowUrl: deployment.workflowUrl,
        approvedFor: "production deployment"
      }
    });

    // Create notification for production deployment
    const { error: notifError } = await db
      .from("notifications")
      .insert({
        user_id: user.id,
        type: "production_deploy_started",
        title: "Production Deployment Started",
        body: `Deploying ${releaseTag} to production`,
        href: deployment.workflowUrl,
        severity: "warning",
        repo_full_name: spec.repo_full_name,
        metadata: { specId: spec.id, releaseTag, releaseSha }
      });
    if (notifError) console.error("notification creation failed", notifError);

    return NextResponse.json({
      ok: true,
      releaseTag,
      releaseSha,
      workflowUrl: deployment.workflowUrl,
      message: "Production deployment started. The release will be live after GitHub Actions completes."
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start production deployment.",
        detail: error instanceof Error ? error.message : "GitHub workflow dispatch failed."
      },
      { status: 500 }
    );
  }
}
