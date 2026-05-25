import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { repoFromBearer } from "@/lib/shipbrain/api-auth";

export const runtime = "nodejs";

function normalizeConclusion(status: string) {
  const value = status.toLowerCase();
  if (["success", "succeeded", "passed"].includes(value)) return "success";
  if (["failure", "failed", "error", "cancelled", "timed_out"].includes(value)) return value === "failure" ? "failure" : value;
  return null;
}

export async function POST(request: Request) {
  const auth = await repoFromBearer(request);
  if (!auth.repo) return NextResponse.json({ error: auth.error }, { status: 401 });
  const body = await request.json();
  const repoFullName = String(body.repo ?? auth.repo.full_name);
  if (repoFullName !== auth.repo.full_name) {
    return NextResponse.json({ error: "API key is not scoped to this repository." }, { status: 403 });
  }

  const runId = Number(body.run_id);
  if (!Number.isFinite(runId)) return NextResponse.json({ error: "run_id is required." }, { status: 400 });

  const statusRaw = String(body.status ?? "completed");
  const conclusion = normalizeConclusion(statusRaw);
  const supabase = getSupabaseAdminClient();
  const prNumber = Number(body.pr_number);
  const { data: spec } = Number.isFinite(prNumber)
    ? await supabase
        .from("specs")
        .select("id, pr_number")
        .eq("repo_full_name", repoFullName)
        .eq("pr_number", prNumber)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const { error } = await supabase.from("ci_runs").upsert(
    {
      repo_id: auth.repo.id,
      spec_id: spec?.id ?? null,
      github_run_id: runId,
      pr_number: Number.isFinite(prNumber) ? prNumber : null,
      repo_full_name: repoFullName,
      workflow_name: String(body.workflow_name ?? "ShipBrain CI"),
      title: String(body.workflow_name ?? "ShipBrain CI"),
      html_url: String(body.run_url ?? ""),
      head_sha: String(body.sha ?? ""),
      branch: String(body.branch ?? ""),
      status: "completed",
      conclusion,
      environment: String(body.environment ?? "dev"),
      updated_at: new Date().toISOString()
    },
    { onConflict: "github_run_id" }
  );

  if (error) return NextResponse.json({ error: "Unable to record CI result.", detail: error.message }, { status: 500 });

  if (spec?.id) {
    await supabase
      .from("specs")
      .update({
        ci_status: "completed",
        ci_conclusion: conclusion,
        latest_ci_run_id: runId,
        feature_head_sha: String(body.sha ?? ""),
        feature_last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);
  }

  return NextResponse.json({ ok: true });
}
