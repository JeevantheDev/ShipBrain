import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user: authUser }
  } = await supabase.auth.getUser();

  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const runId = body.runId ? Number(body.runId) : null;
  const repoFullName = String(body.repo ?? "");

  if (!runId || !repoFullName) {
    return NextResponse.json({ error: "runId and repo are required" }, { status: 400 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("github_access_token")
    .eq("id", authUser.id)
    .single();

  const userGitHubToken = profile?.github_access_token;
  if (!userGitHubToken) {
    return NextResponse.json({ error: "GitHub not connected for user." }, { status: 409 });
  }

  const { owner, repo } = splitRepo(repoFullName);
  const octokit = getOctokit(userGitHubToken);

  try {
    // Trigger rerun of the workflow run
    await octokit.actions.reRunWorkflow({
      owner,
      repo,
      run_id: runId
    });

    return NextResponse.json({ ok: true, message: "Workflow run rerun successfully." });
  } catch (error: any) {
    console.error("Failed to rerun workflow:", error);
    return NextResponse.json({
      error: "Failed to rerun workflow run.",
      detail: error.message ?? "Unknown error"
    }, { status: 500 });
  }
}
