import { NextResponse } from "next/server";
import { dispatchDevelopPreviewDeploy } from "@/lib/github/deployments";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Start an initial preview deployment for a newly connected repo.
 * This doesn't require a spec - it just triggers the preview workflow.
 */
export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const repoFullName = String(body.repoFullName ?? "");
  const branch = String(body.branch ?? "develop");

  if (!repoFullName) {
    return NextResponse.json({ error: "repoFullName is required" }, { status: 400 });
  }

  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    return NextResponse.json({ error: "Invalid repo format. Expected owner/repo" }, { status: 400 });
  }

  // Verify repo is connected to this user
  const { data: repoRow, error: repoError } = await supabase
    .from("repos")
    .select("id, full_name, default_branch")
    .eq("full_name", repoFullName)
    .eq("user_id", user.id)
    .single();

  if (repoError || !repoRow) {
    return NextResponse.json({ error: "Repo not found or not connected.", detail: repoError?.message }, { status: 404 });
  }

  try {
    const deployment = await dispatchDevelopPreviewDeploy({
      owner,
      repo,
      ref: branch,
      defaultBranch: repoRow.default_branch || "main",
      sourcePrNumber: undefined
    });

    // Log the deployment action
    await supabase.from("approval_events").insert({
      entity_type: "repo",
      entity_id: repoRow.id,
      action: "initial_deploy",
      actor_id: user.id,
      note: `Started initial ${branch} preview deployment`,
      metadata: {
        repo: repoFullName,
        branch,
        workflowUrl: deployment.workflowUrl,
        source: "repo_onboarding"
      }
    });

    return NextResponse.json({
      ok: true,
      workflowUrl: deployment.workflowUrl,
      message: `Initial preview deployment started for ${branch}. Check CI Monitor for progress.`
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start initial deployment.",
        detail: error instanceof Error ? error.message : "GitHub workflow dispatch failed."
      },
      { status: 500 }
    );
  }
}
