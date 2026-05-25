import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { repoFromBearer } from "@/lib/shipbrain/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await repoFromBearer(request);
  if (!auth.repo) return NextResponse.json({ error: auth.error }, { status: 401 });
  const body = await request.json();
  const repoFullName = String(body.repo ?? auth.repo.full_name);
  if (repoFullName !== auth.repo.full_name) return NextResponse.json({ error: "API key is not scoped to this repository." }, { status: 403 });

  const prNumber = Number(body.pr_number);
  const supabase = getSupabaseAdminClient();
  const { data: spec } = Number.isFinite(prNumber)
    ? await supabase
        .from("specs")
        .select("id")
        .eq("repo_full_name", repoFullName)
        .eq("pr_number", prNumber)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  if (spec?.id) {
    await supabase
      .from("specs")
      .update({
        preview_url: body.preview_url ?? null,
        preview_branch_alias: body.branch_alias ?? null,
        preview_status: "deployed",
        preview_deployed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);
  }

  return NextResponse.json({ ok: true });
}
