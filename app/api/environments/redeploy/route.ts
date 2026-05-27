import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { dispatchDevelopPreviewDeploy, dispatchCloudflareProductionDeploy } from "@/lib/github/deployments";
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
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { repo: repoFullName, environment, branch } = body;

  if (!repoFullName) {
    return NextResponse.json({ error: "repo is required" }, { status: 400 });
  }

  if (!environment || !["preview", "production"].includes(environment)) {
    return NextResponse.json({ error: "environment must be 'preview' or 'production'" }, { status: 400 });
  }

  // Verify user owns this repo
  const { data: repoRecord, error: repoError } = await supabase
    .from("repos")
    .select("id, full_name, default_branch")
    .eq("full_name", repoFullName)
    .eq("user_id", user.id)
    .single();

  if (repoError || !repoRecord) {
    return NextResponse.json({ error: "Repository not found or not connected" }, { status: 404 });
  }

  const { owner, repo } = splitRepo(repoFullName);
  const defaultBranch = repoRecord.default_branch || "main";

  try {
    if (environment === "preview") {
      // Dispatch preview deployment from develop branch
      const deployment = await dispatchDevelopPreviewDeploy({
        owner,
        repo,
        ref: branch || "develop",
        defaultBranch
      });

      // Log the action
      await supabase.from("approval_events").insert({
        entity_type: "repo",
        entity_id: repoRecord.id,
        action: "redeploy_preview",
        actor_id: user.id,
        note: `Triggered preview redeployment from Environments widget`,
        metadata: {
          repo: repoFullName,
          branch: branch || "develop",
          workflowUrl: deployment.workflowUrl
        }
      });

      return NextResponse.json({
        ok: true,
        workflowUrl: deployment.workflowUrl,
        message: "Preview redeployment started"
      });

    } else {
      // For production, we need to get the latest SHA from main
      const octokit = getOctokit();
      const { data: ref } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`
      });

      const releaseSha = ref.object.sha;
      const releaseTag = generateReleaseTag();

      // Create release tag
      try {
        const { data: tagObject } = await octokit.git.createTag({
          owner,
          repo,
          tag: releaseTag,
          message: `Production redeploy from ShipBrain`,
          object: releaseSha,
          type: "commit"
        });

        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/tags/${releaseTag}`,
          sha: tagObject.sha
        });
      } catch (tagError) {
        // Tag might already exist, continue
        console.error("Tag creation error:", tagError);
      }

      // Dispatch production deployment
      const deployment = await dispatchCloudflareProductionDeploy({
        owner,
        repo,
        releaseTag,
        releaseSha
      });

      // Log the action
      await supabase.from("approval_events").insert({
        entity_type: "repo",
        entity_id: repoRecord.id,
        action: "redeploy_production",
        actor_id: user.id,
        note: `Triggered production redeployment from Environments widget`,
        metadata: {
          repo: repoFullName,
          releaseTag,
          releaseSha,
          workflowUrl: deployment.workflowUrl
        }
      });

      return NextResponse.json({
        ok: true,
        releaseTag,
        releaseSha,
        workflowUrl: deployment.workflowUrl,
        message: "Production redeployment started"
      });
    }
  } catch (error) {
    return NextResponse.json({
      error: "Failed to trigger redeployment",
      detail: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}
