import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Latest preview per repo (most recently updated spec with a deployed preview URL)
  const { data: previews } = await supabase
    .from("specs")
    .select("id, repo_full_name, branch_name, preview_url, preview_status, merge_sha, updated_at")
    .eq("user_id", user.id)
    .not("preview_url", "is", null)
    .eq("preview_status", "deployed")
    .order("updated_at", { ascending: false })
    .limit(20);

  // Fetch repos with canonical current_version (single source of truth)
  const { data: repos } = await supabase
    .from("repos")
    .select("full_name, setup_metadata, current_version, current_version_sha, current_version_deployed_at, current_version_type")
    .eq("user_id", user.id);

  // Build maps from repos data
  const repoMap: Record<string, string> = {};
  const repoVersionMap: Record<string, { version: string; sha: string; deployedAt: string; type: string } | null> = {};

  for (const r of repos ?? []) {
    const metadata = r.setup_metadata as any;
    if (metadata?.cloudflareProjectUrl) {
      repoMap[r.full_name] = metadata.cloudflareProjectUrl;
    }
    if (r.current_version) {
      repoVersionMap[r.full_name] = {
        version: r.current_version,
        sha: r.current_version_sha,
        deployedAt: r.current_version_deployed_at,
        type: r.current_version_type
      };
    } else {
      repoVersionMap[r.full_name] = null;
    }
  }

  // Deduplicate: keep only the latest preview per repo
  const seenPreviewRepos = new Set<string>();
  const latestPreviews = (previews ?? []).filter((spec) => {
    if (seenPreviewRepos.has(spec.repo_full_name)) return false;
    seenPreviewRepos.add(spec.repo_full_name);
    return true;
  });

  // Build production environments from repos canonical version
  const prodEnvironments = (repos ?? [])
    .filter((r) => repoVersionMap[r.full_name] || repoMap[r.full_name])
    .map((r) => {
      const versionInfo = repoVersionMap[r.full_name];
      return {
        id: `prod-${r.full_name}`,
        repo: r.full_name,
        type: "production" as const,
        url: repoMap[r.full_name] ?? "#",
        branch: "main",
        releaseTag: versionInfo?.version ?? null,
        commitSha: versionInfo?.sha ? versionInfo.sha.slice(0, 7) : null,
        status: versionInfo ? "deployed" : "not_deployed",
        updatedAt: versionInfo?.deployedAt ?? null
      };
    });

  const environments = [
    ...latestPreviews.map((spec) => ({
      id: `preview-${spec.repo_full_name}`,
      repo: spec.repo_full_name,
      type: "preview" as const,
      url: spec.preview_url,
      branch: "develop",
      commitSha: spec.merge_sha ? (spec.merge_sha as string).slice(0, 7) : null,
      status: spec.preview_status,
      updatedAt: spec.updated_at
    })),
    ...prodEnvironments
  ].sort((a, b) => {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  });

  return NextResponse.json(environments);
}
