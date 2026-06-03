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

  // Latest production per repo (deployed or deploying to main)
  // Order by deployed_at to get the ACTUAL current production, not just most recently updated
  const { data: productions } = await supabase
    .from("specs")
    .select("id, repo_full_name, branch_name, base_branch, production_url, deployment_url, release_status, release_tag, release_sha, deployed_at, updated_at")
    .eq("user_id", user.id)
    .in("release_status", ["deployed", "deploying", "pending_deploy"])
    .order("deployed_at", { ascending: false, nullsFirst: false })
    .limit(20);

  // Fetch repos to map repository name to production URL
  const { data: repos } = await supabase
    .from("repos")
    .select("full_name, setup_metadata")
    .eq("user_id", user.id);

  const repoMap: Record<string, string> = {};
  for (const r of repos ?? []) {
    const metadata = r.setup_metadata as any;
    if (metadata?.cloudflareProjectUrl) {
      repoMap[r.full_name] = metadata.cloudflareProjectUrl;
    }
  }

  // Deduplicate: keep only the latest preview per repo
  const seenPreviewRepos = new Set<string>();
  const latestPreviews = (previews ?? []).filter((spec) => {
    if (seenPreviewRepos.has(spec.repo_full_name)) return false;
    seenPreviewRepos.add(spec.repo_full_name);
    return true;
  });

  // Deduplicate: keep only the latest production per repo
  const seenProdRepos = new Set<string>();
  const latestProductions = (productions ?? []).filter((spec) => {
    if (seenProdRepos.has(spec.repo_full_name)) return false;
    seenProdRepos.add(spec.repo_full_name);
    return true;
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
    ...latestProductions.filter((spec) => spec.production_url || spec.deployment_url || spec.release_status).map((spec) => ({
      id: `prod-${spec.repo_full_name}`,
      repo: spec.repo_full_name,
      type: "production" as const,
      url: spec.production_url ?? repoMap[spec.repo_full_name] ?? spec.deployment_url ?? "#",
      branch: spec.base_branch === "main" ? "main" : "main",
      releaseTag: spec.release_tag ?? null,
      commitSha: spec.release_sha ? (spec.release_sha as string).slice(0, 7) : null,
      status: spec.release_status,
      updatedAt: spec.deployed_at ?? spec.updated_at
    }))
  ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return NextResponse.json(environments);
}
