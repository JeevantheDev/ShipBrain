import { NextResponse } from "next/server";
import { dispatchDevelopPreviewDeploy } from "@/lib/github/deployments";
import { getSupabaseServerClient } from "@/lib/supabase/server";

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
    .select("id, status, repo_full_name, branch_name, base_branch, pr_number, merge_sha, preview_status")
    .eq("id", specId)
    .eq("user_id", user.id)
    .single();

  if (specError || !spec) {
    return NextResponse.json({ error: "Spec not found.", detail: specError?.message }, { status: 404 });
  }

  if (spec.status !== "merged") {
    return NextResponse.json(
      { error: "Spec must be merged before redeploying preview.", detail: `Current status: ${spec.status}` },
      { status: 409 }
    );
  }

  if (spec.base_branch !== "develop") {
    return NextResponse.json(
      { error: "Preview redeployment is only available for PRs merged to develop.", detail: `Base branch: ${spec.base_branch}` },
      { status: 409 }
    );
  }

  if (spec.preview_status === "deploying") {
    return NextResponse.json(
      { error: "Preview deployment is already in progress.", detail: "Wait for the current deployment to complete." },
      { status: 409 }
    );
  }

  const { owner, repo } = splitRepo(spec.repo_full_name);

  try {
    const { data: repoRow } = await supabase
      .from("repos")
      .select("default_branch")
      .eq("full_name", spec.repo_full_name)
      .single();

    const defaultBranch = repoRow?.default_branch || "main";

    const deployment = await dispatchDevelopPreviewDeploy({
      owner,
      repo,
      ref: "develop",
      defaultBranch,
      sourcePrNumber: spec.pr_number
    });

    // Reset preview status and URL to trigger a fresh deployment
    await supabase
      .from("specs")
      .update({
        preview_status: "deploying",
        preview_url: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);

    await supabase.from("approval_events").insert({
      entity_type: "spec",
      entity_id: spec.id,
      action: "redeploy_preview",
      actor_id: user.id,
      note: "Triggered preview redeployment from Deployment Queue",
      metadata: {
        specId: spec.id,
        repo: spec.repo_full_name,
        branch: "develop",
        prNumber: spec.pr_number,
        workflowUrl: deployment.workflowUrl
      }
    });

    return NextResponse.json({
      ok: true,
      workflowUrl: deployment.workflowUrl,
      message: "Preview redeployment started. The preview URL will update after GitHub Actions completes."
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start preview redeployment.",
        detail: error instanceof Error ? error.message : "GitHub workflow dispatch failed."
      },
      { status: 500 }
    );
  }
}
