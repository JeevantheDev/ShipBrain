import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/repos/current-version
 *
 * Returns the current production version for the user's active repo.
 * This is the canonical source of truth for version - updated only on
 * successful production deployments (release, hotfix, rollback).
 */
export async function GET() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // First try to get user's active repo
  const { data: activeRepo } = await supabase
    .from("user_active_repos")
    .select("repo_full_name")
    .eq("user_id", user.id)
    .maybeSingle();

  let repoFullName = activeRepo?.repo_full_name;

  // If no active repo, get the most recently connected repo
  if (!repoFullName) {
    const { data: connectedRepo } = await supabase
      .from("repos")
      .select("full_name")
      .eq("user_id", user.id)
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    repoFullName = connectedRepo?.full_name;
  }

  if (!repoFullName) {
    return NextResponse.json({ currentVersion: null, repoName: null });
  }

  // Get the repo's current version info
  const { data: repo, error } = await supabase
    .from("repos")
    .select("full_name, current_version, current_version_sha, current_version_deployed_at, current_version_type")
    .eq("full_name", repoFullName)
    .maybeSingle();

  if (error) {
    console.error("[GET /api/repos/current-version] Error:", error);
    return NextResponse.json({ error: "Failed to fetch repo version" }, { status: 500 });
  }

  return NextResponse.json({
    repoName: repo?.full_name?.split("/")[1] ?? null,
    repoFullName: repo?.full_name ?? null,
    currentVersion: repo?.current_version ?? null,
    currentVersionSha: repo?.current_version_sha ?? null,
    currentVersionDeployedAt: repo?.current_version_deployed_at ?? null,
    currentVersionType: repo?.current_version_type ?? null
  });
}
