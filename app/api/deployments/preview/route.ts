import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { repoFromBearer } from "@/lib/shipbrain/api-auth";
import { updateTraceBySpec } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const previewBranch = String(body.branch ?? "develop");
    const previewUrl = body.preview_url ?? null;

    await supabase
      .from("specs")
      .update({
        preview_url: previewUrl,
        preview_branch_alias: body.branch_alias ?? null,
        preview_status: "deployed",
        preview_deployed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);

    if (body.run_url) {
      await supabase
        .from("ci_runs")
        .update({
          branch: previewBranch,
          environment: "preview",
          preview_url: previewUrl,
          branch_alias: body.branch_alias ?? null,
          updated_at: new Date().toISOString()
        })
        .eq("html_url", body.run_url)
        .eq("repo_full_name", repoFullName);
    }

    // Update release trace to preview_live status
    await updateTraceBySpec(spec.id, {
      status: "preview_live",
      current_phase: "preview",
      preview_deployment: {
        status: "deployed",
        url: previewUrl,
        branch: previewBranch,
        branchAlias: body.branch_alias ?? null,
        timestamp: new Date().toISOString()
      }
    }, {
      eventType: "preview_deployed",
      source: "github",
      actor: "github-actions",
      actorType: "system",
      details: {
        previewUrl,
        branch: previewBranch,
        prNumber,
        runUrl: body.run_url
      }
    }).catch((err) => console.error("Failed to update trace for preview deployment:", err));
  }

  return NextResponse.json({ ok: true });
}
