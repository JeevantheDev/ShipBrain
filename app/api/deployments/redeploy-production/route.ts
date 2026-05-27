import { NextResponse } from "next/server";
import { dispatchCloudflareProductionDeploy } from "@/lib/github/deployments";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getOctokit } from "@/lib/github/client";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
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
  if (!specId) {
    return NextResponse.json({ error: "specId is required" }, { status: 400 });
  }

  const { data: spec, error: specError } = await supabase
    .from("specs")
    .select("id, status, repo_full_name, branch_name, base_branch, release_status, release_tag, release_sha")
    .eq("id", specId)
    .eq("user_id", user.id)
    .single();

  if (specError || !spec) {
    return NextResponse.json({ error: "Spec not found.", detail: specError?.message }, { status: 404 });
  }

  // Allow redeploy if spec was previously deployed or failed
  if (!["deployed", "failed", "pending_deploy"].includes(spec.release_status ?? "")) {
    return NextResponse.json(
      { error: "Spec is not in a valid state for redeployment.", detail: `Current release_status: ${spec.release_status}` },
      { status: 409 }
    );
  }

  if (!spec.release_tag || !spec.release_sha) {
    return NextResponse.json(
      { error: "Release tag and SHA are required for redeployment.", detail: "Missing release information." },
      { status: 409 }
    );
  }

  const { owner, repo } = splitRepo(spec.repo_full_name);
  let releaseSha = spec.release_sha;

  // Ensure we have a full 40-character SHA
  if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
    try {
      const octokit = getOctokit();
      const { data: commit } = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: releaseSha
      });
      releaseSha = commit.sha;
    } catch {
      // Try getting latest commit on main as fallback
      try {
        const octokit = getOctokit();
        const { data: ref } = await octokit.git.getRef({
          owner,
          repo,
          ref: "heads/main"
        });
        releaseSha = ref.object.sha;
      } catch {
        return NextResponse.json(
          { error: "Unable to resolve full SHA.", detail: `Short SHA "${releaseSha}" could not be resolved.` },
          { status: 409 }
        );
      }
    }
  }

  try {
    const deployment = await dispatchCloudflareProductionDeploy({
      owner,
      repo,
      releaseTag: spec.release_tag,
      releaseSha
    });

    // Update spec to deploying status
    await supabase
      .from("specs")
      .update({
        release_status: "deploying",
        release_sha: releaseSha,
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);

    await supabase.from("approval_events").insert({
      entity_type: "spec",
      entity_id: spec.id,
      action: "redeploy_production",
      actor_id: user.id,
      note: "Triggered production redeployment from Deployment Queue",
      metadata: {
        specId: spec.id,
        repo: spec.repo_full_name,
        releaseTag: spec.release_tag,
        releaseSha,
        workflowUrl: deployment.workflowUrl
      }
    });

    return NextResponse.json({
      ok: true,
      releaseTag: spec.release_tag,
      releaseSha,
      workflowUrl: deployment.workflowUrl,
      message: "Production redeployment started. The release will be updated after GitHub Actions completes."
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start production redeployment.",
        detail: error instanceof Error ? error.message : "GitHub workflow dispatch failed."
      },
      { status: 500 }
    );
  }
}
