import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";

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

  const { owner, repo } = splitRepo(repoFullName);
  const octokit = getOctokit();

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
