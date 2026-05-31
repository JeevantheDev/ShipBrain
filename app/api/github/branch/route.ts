import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner = "test", repo = "repo"] = repoFullName.includes("/") ? repoFullName.split("/") : ["test", repoFullName];
  return { owner, repo };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoFullName = url.searchParams.get("repo");
  const branch = url.searchParams.get("branch");

  if (!repoFullName || !branch) {
    return NextResponse.json({ error: "repo and branch are required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const user = session?.user ?? null;

  let token = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("github_access_token")
      .eq("id", user.id)
      .maybeSingle();
    token = profile?.github_access_token ?? null;
  }

  const { owner, repo } = splitRepo(repoFullName);
  const octokit = getOctokit(token ?? undefined);

  try {
    await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`
    });
    return NextResponse.json({ exists: true, available: false });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status === 404) {
      return NextResponse.json({ exists: false, available: true });
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to check branch"
      },
      { status: 500 }
    );
  }
}
