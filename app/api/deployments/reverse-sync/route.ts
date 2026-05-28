import { NextResponse } from "next/server";
import { updateTraceByIncident } from "@/lib/orchestrator";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { repoFromBearer } from "@/lib/shipbrain/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await repoFromBearer(request);
  if (!auth.repo) return NextResponse.json({ error: auth.error }, { status: 401 });

  const body = await request.json();
  const repoFullName = String(body.repo ?? auth.repo.full_name);
  if (repoFullName !== auth.repo.full_name) {
    return NextResponse.json({ error: "API key is not scoped to this repository." }, { status: 403 });
  }

  const releaseTag = String(body.release_tag ?? body.releaseTag ?? "");
  const status = String(body.status ?? "").toLowerCase();
  const prNumber = body.pr_number ? Number(body.pr_number) : null;
  const prUrl = body.pr_url ? String(body.pr_url) : null;
  const syncBranch = body.sync_branch ? String(body.sync_branch) : null;
  const error = body.error ? String(body.error) : null;

  const supabase = getSupabaseAdminClient();
  const { data: incident } = await supabase
    .from("incidents")
    .select("id")
    .eq("repo_full_name", repoFullName)
    .eq("release_version", releaseTag)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!incident?.id) {
    return NextResponse.json({ ok: true, matched: false });
  }

  const syncStatus = status === "success" ? "open" : "failed";
  const updates: Record<string, unknown> = {
    reverse_sync_pr_status: syncStatus,
    reverse_sync_branch: "develop",
    reverse_sync_error: error,
    updated_at: new Date().toISOString()
  };
  if (prNumber) updates.reverse_sync_pr_number = prNumber;
  if (prUrl) updates.reverse_sync_pr_url = prUrl;
  if (status === "success") updates.reverse_sync_created_at = new Date().toISOString();

  await supabase.from("incidents").update(updates).eq("id", incident.id);

  await updateTraceByIncident(incident.id, {
    reverse_sync_pr_number: prNumber,
    reverse_sync_pr_url: prUrl,
    reverse_sync_status: syncStatus
  }, {
    eventType: status === "success" ? "reverse_sync_created" : "deployment_failed",
    source: "github",
    actor: "github-actions",
    details: { releaseTag, prNumber, prUrl, syncBranch, status, error }
  }).catch(() => null);

  return NextResponse.json({ ok: true, matched: true, reverseSyncStatus: syncStatus });
}
