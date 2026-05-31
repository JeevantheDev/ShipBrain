import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const repo = searchParams.get("repo");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 50);

  let query = supabase
    .from("specs")
    .select("id, repo_full_name, raw_spec, release_tag, release_sha, release_status, deployed_at, production_url, decomposed_tasks, updated_at")
    .eq("user_id", user.id)
    .eq("release_status", "deployed")
    .not("release_tag", "is", null)
    .order("deployed_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (repo) {
    query = query.eq("repo_full_name", repo);
  }

  const { data: specs, error } = await query;

  if (error) {
    return NextResponse.json({ error: "Unable to load release history.", detail: error.message }, { status: 500 });
  }

  const releases = (specs ?? []).map((spec) => {
    const tasks = spec.decomposed_tasks as { prTitle?: string } | null;
    return {
      specId: spec.id,
      repoFullName: spec.repo_full_name,
      releaseTag: spec.release_tag,
      releaseSha: spec.release_sha,
      deployedAt: spec.deployed_at,
      productionUrl: spec.production_url,
      title: tasks?.prTitle ?? spec.raw_spec?.slice(0, 80) ?? spec.release_tag,
      status: spec.release_status
    };
  });

  return NextResponse.json(releases);
}
