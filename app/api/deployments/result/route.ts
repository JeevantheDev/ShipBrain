import { NextResponse } from "next/server";
import { updateTraceByIncident, updateTraceBySpec } from "@/lib/orchestrator";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { repoFromBearer } from "@/lib/shipbrain/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await repoFromBearer(request);
  if (!auth.repo) return NextResponse.json({ error: auth.error }, { status: 401 });
  const body = await request.json();
  const repoFullName = String(body.repo ?? auth.repo.full_name);
  if (repoFullName !== auth.repo.full_name) return NextResponse.json({ error: "API key is not scoped to this repository." }, { status: 403 });

  const tag = String(body.tag ?? "");
  const sha = String(body.sha ?? "");
  const status = String(body.status ?? "").toLowerCase();
  const releaseStatus = status === "success" ? "deployed" : "failed";
  const isHotfix = String(body.is_hotfix ?? "").toLowerCase() === "true";
  const supabase = getSupabaseAdminClient();

  const { data: spec } = await supabase
    .from("specs")
    .select("id")
    .eq("repo_full_name", repoFullName)
    .eq("release_tag", tag)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (spec?.id) {
    await supabase
      .from("specs")
      .update({
        release_status: releaseStatus,
        deployment_url: body.run_url ?? null,
        release_sha: sha || null,
        deployed_at: releaseStatus === "deployed" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);

    await updateTraceBySpec(spec.id, {
      status: releaseStatus === "deployed" ? "production_live" : "failed",
      production_deployment: {
        status: releaseStatus,
        tag,
        sha,
        url: body.deploy_url ?? body.run_url ?? null,
        runUrl: body.run_url ?? null,
        timestamp: new Date().toISOString()
      }
    }, {
      eventType: releaseStatus === "deployed" ? "deployment_succeeded" : "deployment_failed",
      source: "github",
      actor: "github-actions",
      details: body
    }).catch(() => null);
  }

  if (isHotfix && tag) {
    const { data: incident } = await supabase
      .from("incidents")
      .select("id, reverse_sync_pr_number, reverse_sync_pr_status")
      .eq("repo_full_name", repoFullName)
      .eq("release_version", tag)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (incident?.id) {
      await supabase
        .from("incidents")
        .update({
          status: releaseStatus === "deployed" ? "resolved" : "investigating",
          updated_at: new Date().toISOString()
        })
        .eq("id", incident.id);

      await updateTraceByIncident(incident.id, {
        status: releaseStatus === "deployed" ? "production_live" : "failed",
        production_deployment: {
          status: releaseStatus,
          tag,
          sha,
          url: body.deploy_url ?? body.run_url ?? null,
          runUrl: body.run_url ?? null,
          timestamp: new Date().toISOString()
        },
        reverse_sync_pr_number: incident.reverse_sync_pr_number ?? null,
        reverse_sync_status: incident.reverse_sync_pr_status ?? null
      }, {
        eventType: releaseStatus === "deployed" ? "deployment_succeeded" : "deployment_failed",
        source: "github",
        actor: "github-actions",
        details: body
      }).catch(() => null);
    }
  }

  return NextResponse.json({ ok: true, releaseStatus });
}
