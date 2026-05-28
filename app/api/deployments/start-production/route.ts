import { NextResponse } from "next/server";
import { dispatchVercelProductionDeploy, createReleaseTag } from "@/lib/github/deployments";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getOctokit } from "@/lib/github/client";

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
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const specId = String(body.specId ?? "");
  const requestedReleaseTag = String(body.releaseTag ?? "").trim();
  if (!specId) {
    return NextResponse.json({ error: "specId is required" }, { status: 400 });
  }

  const { data: spec, error: specError } = await supabase
    .from("specs")
    .select("id, status, repo_full_name, branch_name, base_branch, pr_number, merge_sha, release_status, release_pr_status, release_tag, release_sha")
    .eq("id", specId)
    .eq("user_id", user.id)
    .single();

  if (specError || !spec) {
    return NextResponse.json({ error: "Spec not found.", detail: specError?.message }, { status: 404 });
  }

  const isMergedReleasePromotion = spec.status === "merged" && spec.branch_name === "develop" && spec.base_branch === "main";
  const isPendingDeploy = spec.release_status === "pending_deploy" && spec.release_pr_status === "merged";

  if (!isPendingDeploy && !isMergedReleasePromotion) {
    return NextResponse.json(
      { error: "Spec is not ready for production deployment.", detail: `Current release_status: ${spec.release_status}` },
      { status: 409 }
    );
  }

  if (!isMergedReleasePromotion && spec.release_pr_status !== "merged") {
    return NextResponse.json(
      { error: "Release PR must be merged before deploying to production.", detail: `Current release_pr_status: ${spec.release_pr_status}` },
      { status: 409 }
    );
  }

  const { owner, repo } = splitRepo(spec.repo_full_name);
  const releaseTag = requestedReleaseTag || spec.release_tag || generateReleaseTag();
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

  if (!releaseSha && isMergedReleasePromotion) {
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
      await supabase
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
        await supabase
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

    // Dispatch production deploy workflow
    const deployment = await dispatchVercelProductionDeploy({
      owner,
      repo,
      releaseTag,
      releaseSha
    });

    // Update spec with deployment info
    await supabase
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

    // Record approval event
    await supabase.from("approval_events").insert({
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
