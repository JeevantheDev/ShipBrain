import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { createReleaseTag, dispatchDevelopPreviewDeploy, dispatchCloudflareProductionDeploy } from "@/lib/github/deployments";
import { getOctokit } from "@/lib/github/client";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

function generateReleaseTag() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `release-v${date}-${time}-${suffix}`;
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { repo: repoFullName, environment, branch } = body;
  const requestedReleaseTag = String(body.releaseTag ?? "").trim();

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
      const { data: latestRelease, error: releaseError } = await supabase
        .from("specs")
        .select("id")
        .eq("user_id", user.id)
        .eq("repo_full_name", repoFullName)
        .eq("release_status", "deployed")
        .order("deployed_at", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (releaseError || !latestRelease?.id) {
        return NextResponse.json(
          {
            error: "Production has not been deployed yet.",
            detail: "Redeploy is available only after the first successful production deployment. Use CI Monitor to deploy the merged release PR first."
          },
          { status: 409 }
        );
      }

      const octokit = getOctokit();
      const { data: ref } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`
      });

      const releaseSha = ref.object.sha;
      const releaseTag = requestedReleaseTag || generateReleaseTag();

      await createReleaseTag({
        owner,
        repo,
        tag: releaseTag,
        sha: releaseSha,
        message: `Production redeploy ${releaseTag} from ShipBrain`
      });

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
          source: "current_main",
          workflowUrl: deployment.workflowUrl
        }
      });

      await supabase
        .from("specs")
        .update({
          release_status: "deploying",
          release_tag: releaseTag,
          release_sha: releaseSha,
          updated_at: new Date().toISOString()
        })
        .eq("id", latestRelease.id);

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
