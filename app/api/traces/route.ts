import { NextResponse } from "next/server";
import { createOrUpdateTrace } from "@/lib/orchestrator";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseLimit(value: string | null) {
  const limit = Number(value ?? 30);
  return Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 30;
}

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const repo = url.searchParams.get("repo");
  const limit = parseLimit(url.searchParams.get("limit"));

  let query = supabase
    .from("release_traces")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (status) query = query.eq("status", status);
  if (repo) query = query.eq("repo_full_name", repo);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Unable to load traces.", detail: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (!body.repoFullName || !body.title || !body.sourceBranch || !body.targetBranch) {
    return NextResponse.json({ error: "repoFullName, title, sourceBranch, and targetBranch are required." }, { status: 400 });
  }

  const trace = await createOrUpdateTrace({
    userId: user.id,
    repoFullName: String(body.repoFullName),
    title: String(body.title),
    description: body.description ? String(body.description) : null,
    type: body.type,
    status: body.status,
    sourceBranch: String(body.sourceBranch),
    targetBranch: String(body.targetBranch),
    draftPrNumber: body.draftPrNumber ?? null,
    draftPrUrl: body.draftPrUrl ?? null,
    releasePrNumber: body.releasePrNumber ?? null,
    releasePrUrl: body.releasePrUrl ?? null,
    source: "manual",
    actor: user.email ?? user.id,
    eventType: "trace_created",
    details: { createdFrom: "api" }
  });
  return NextResponse.json(trace);
}
