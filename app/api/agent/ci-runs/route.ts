import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/agent/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 50);
  const repo = url.searchParams.get("repo");

  const { data: repos, error: reposError } = await auth.supabase
    .from("repos")
    .select("full_name")
    .eq("user_id", auth.userId);
  if (reposError) return NextResponse.json({ error: "Unable to load connected repos.", detail: reposError.message }, { status: 500 });

  const repoNames = (repos ?? []).map((item) => item.full_name).filter(Boolean);
  if (!repoNames.length) return NextResponse.json({ ciRuns: [] });

  let query = auth.supabase
    .from("ci_runs")
    .select("*")
    .in("repo_full_name", repoNames)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (repo && repoNames.includes(repo)) query = query.eq("repo_full_name", repo);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Unable to load CI runs.", detail: error.message }, { status: 500 });
  return NextResponse.json({ ciRuns: data ?? [] });
}
