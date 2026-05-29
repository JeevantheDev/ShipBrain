import { NextResponse } from "next/server";
import { updateTraceByIncident, updateTraceBySpec, completeRollback } from "@/lib/orchestrator";
import { createReverseSyncPR } from "@/lib/github/pr";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { repoFromBearer } from "@/lib/shipbrain/api-auth";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

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
  const isRollback = String(body.is_rollback ?? "").toLowerCase() === "true";
  const supabase = getSupabaseAdminClient();

  // Check if this is a rollback deployment
  if (isRollback || tag) {
    const { data: activeRollback } = await supabase
      .from("rollback_history")
      .select("*")
      .eq("repo_full_name", repoFullName)
      .eq("target_release_tag", tag)
      .eq("status", "deploying")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (activeRollback) {
      await completeRollback({
        rollbackId: activeRollback.id,
        repoFullName,
        releaseTag: tag,
        success: releaseStatus === "deployed",
        deployUrl: body.deploy_url ?? body.run_url ?? null,
        errorMessage: releaseStatus === "failed" ? (body.error ?? "Deployment failed") : undefined
      });

      return NextResponse.json({ ok: true, releaseStatus, isRollback: true });
    }
  }

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
      .select("id, title, hotfix_pr_number, reverse_sync_pr_number, reverse_sync_pr_status")
      .eq("repo_full_name", repoFullName)
      .eq("release_version", tag)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (incident?.id) {
      let reverseSyncPrNumber = incident.reverse_sync_pr_number ?? null;
      let reverseSyncPrUrl: string | null = null;
      let reverseSyncStatus = incident.reverse_sync_pr_status ?? null;
      let reverseSyncError: string | null = null;

      if (releaseStatus === "deployed" && !reverseSyncPrNumber && incident.hotfix_pr_number) {
        try {
          const { owner, repo } = splitRepo(repoFullName);
          const reverseSyncPr = await createReverseSyncPR({
            owner,
            repo,
            sourceBranch: "main",
            targetBranch: "develop",
            incidentId: incident.id,
            incidentTitle: incident.title ?? "Incident hotfix",
            hotfixPrNumber: incident.hotfix_pr_number,
            releaseTag: tag
          });
          reverseSyncPrNumber = reverseSyncPr.number;
          reverseSyncPrUrl = reverseSyncPr.html_url;
          reverseSyncStatus = "open";
        } catch (error) {
          reverseSyncStatus = "failed";
          reverseSyncError = error instanceof Error ? error.message : "Failed to create reverse sync PR.";
        }
      }

      const incidentUpdate: Record<string, unknown> = {
        status: releaseStatus === "deployed" ? "resolved" : "investigating",
        reverse_sync_pr_number: reverseSyncPrNumber,
        reverse_sync_pr_status: reverseSyncStatus,
        reverse_sync_error: reverseSyncError,
        updated_at: new Date().toISOString()
      };
      if (releaseStatus === "deployed") incidentUpdate.reverse_sync_branch = "develop";
      if (reverseSyncPrUrl) {
        incidentUpdate.reverse_sync_pr_url = reverseSyncPrUrl;
        incidentUpdate.reverse_sync_created_at = new Date().toISOString();
      }

      await supabase
        .from("incidents")
        .update(incidentUpdate)
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
        reverse_sync_pr_number: reverseSyncPrNumber,
        reverse_sync_pr_url: reverseSyncPrUrl,
        reverse_sync_status: reverseSyncStatus
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
