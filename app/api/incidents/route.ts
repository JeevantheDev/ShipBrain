import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { resolvePagerDutyIncident } from "@/lib/pagerduty/incidents";

export const runtime = "nodejs";

function toIncident(row: any) {
  return {
    id: row.id,
    source: row.alert_source === "pagerduty" ? "production-alert" : row.alert_source,
    status: row.status,
    title: row.title ?? (row.root_cause ? "AI-assisted incident" : "Incident reported"),
    logs: row.raw_logs,
    repo: row.repo_full_name,
    environment: row.environment,
    service: row.service,
    severity: row.severity,
    branch: row.branch,
    commit: row.commit_sha,
    releaseVersion: row.release_version,
    rootCause: row.root_cause,
    fixProposal: row.ai_fix_proposal,
    postmortem: row.postmortem_draft,
    aiAnalysis: row.ai_analysis ?? null,
    hotfixBranch: row.hotfix_branch,
    hotfixBaseBranch: row.hotfix_base_branch,
    hotfixPrNumber: row.hotfix_pr_number,
    hotfixPrUrl: row.hotfix_pr_url,
    hotfixPrStatus: row.hotfix_pr_status,
    hotfixMergeSha: row.hotfix_merge_sha,
    hotfixCommits: row.hotfix_commits ?? [],
    fixApprovedAt: row.fix_approved_at,
    alertProviderLinked: row.alert_source === "pagerduty" && Boolean(row.external_id),
    alertProviderStatus: row.pagerduty_sync_status ?? null,
    alertProviderSyncError: row.pagerduty_sync_error ?? null,
    reverseSyncPrNumber: row.reverse_sync_pr_number ?? null,
    reverseSyncPrUrl: row.reverse_sync_pr_url ?? null,
    reverseSyncPrStatus: row.reverse_sync_pr_status ?? null,
    reverseSyncBranch: row.reverse_sync_branch ?? null,
    reverseSyncCreatedAt: row.reverse_sync_created_at ?? null,
    reverseSyncMergedAt: row.reverse_sync_merged_at ?? null,
    reverseSyncError: row.reverse_sync_error ?? null,
    updatedAt: row.updated_at ?? row.created_at
  };
}

async function getUserOr401() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function GET() {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("incidents")
    .select("id, alert_source, status, title, repo_full_name, environment, service, severity, branch, commit_sha, release_version, raw_logs, root_cause, ai_fix_proposal, postmortem_draft, ai_analysis, hotfix_branch, hotfix_base_branch, hotfix_pr_number, hotfix_pr_url, hotfix_pr_status, hotfix_merge_sha, hotfix_commits, fix_approved_at, external_id, pagerduty_sync_status, pagerduty_sync_error, reverse_sync_pr_number, reverse_sync_pr_url, reverse_sync_pr_status, reverse_sync_branch, reverse_sync_created_at, reverse_sync_merged_at, reverse_sync_error, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: "Unable to load incidents.", detail: error.message }, { status: 500 });
  return NextResponse.json((data ?? []).map(toIncident));
}

export async function POST(request: Request) {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const logs = String(body.logs ?? "").trim();
  if (!logs) return NextResponse.json({ error: "logs are required" }, { status: 400 });

  const { data, error } = await supabase
    .from("incidents")
    .insert({
      user_id: user.id,
      alert_source: body.source ?? "simulation",
      status: "open",
      title: body.title ?? "Manual incident",
      repo_full_name: body.repo ?? null,
      environment: body.environment ?? "sandbox",
      service: body.service ?? "manual",
      severity: body.severity ?? "medium",
      release_version: body.releaseVersion ?? null,
      raw_logs: logs,
      updated_at: new Date().toISOString()
    })
    .select("id, alert_source, status, title, repo_full_name, environment, service, severity, branch, commit_sha, release_version, raw_logs, root_cause, ai_fix_proposal, postmortem_draft, ai_analysis, hotfix_branch, hotfix_base_branch, hotfix_pr_number, hotfix_pr_url, hotfix_pr_status, hotfix_merge_sha, hotfix_commits, fix_approved_at, external_id, pagerduty_sync_status, pagerduty_sync_error, reverse_sync_pr_number, reverse_sync_pr_url, reverse_sync_pr_status, reverse_sync_branch, reverse_sync_created_at, reverse_sync_merged_at, reverse_sync_error, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: "Unable to create incident.", detail: error.message }, { status: 500 });
  return NextResponse.json(toIncident(data));
}

export async function PATCH(request: Request) {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { data: existing, error: existingError } = await supabase
    .from("incidents")
    .select("id, alert_source, external_id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (existingError) return NextResponse.json({ error: "Unable to load incident.", detail: existingError.message }, { status: 500 });

  let pagerDutySyncStatus: string | null = null;
  let pagerDutySyncError: string | null = null;

  if (body.status === "resolved" && existing?.alert_source === "pagerduty" && existing.external_id) {
    const pagerDutyNote = [
      "ShipBrain approved the incident fix.",
      body.rootCause ? `Root cause: ${body.rootCause}` : "",
      body.fixProposal ? `Fix proposal: ${body.fixProposal}` : "",
      body.postmortem ? "Post-mortem draft generated in ShipBrain." : ""
    ].filter(Boolean).join("\n\n");

    const pagerDutyResult = await resolvePagerDutyIncident({
      incidentId: existing.external_id,
      fromEmail: process.env.PAGERDUTY_FROM_EMAIL ?? user.email,
      note: pagerDutyNote
    });

    if (!pagerDutyResult.ok) {
      return NextResponse.json(
        {
          error: "ShipBrain could not resolve the linked production alert.",
          detail: pagerDutyResult.detail ?? "The configured alert provider rejected the incident update. Check ShipBrain alert provider settings."
        },
        { status: 502 }
      );
    }

    pagerDutySyncStatus = pagerDutyResult.skipped ? "skipped" : "resolved";
    pagerDutySyncError = pagerDutyResult.detail ?? null;
  }

  const { data, error } = await supabase
    .from("incidents")
    .update({
      status: body.status,
      root_cause: body.rootCause ?? undefined,
      ai_fix_proposal: body.fixProposal ?? undefined,
      postmortem_draft: body.postmortem ?? undefined,
      ai_analysis: body.aiAnalysis ?? undefined,
      hotfix_commits: body.hotfixCommits ?? undefined,
      pagerduty_sync_status: pagerDutySyncStatus ?? undefined,
      pagerduty_sync_error: pagerDutySyncError,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, alert_source, status, title, repo_full_name, environment, service, severity, branch, commit_sha, release_version, raw_logs, root_cause, ai_fix_proposal, postmortem_draft, ai_analysis, hotfix_branch, hotfix_base_branch, hotfix_pr_number, hotfix_pr_url, hotfix_pr_status, hotfix_merge_sha, hotfix_commits, fix_approved_at, external_id, pagerduty_sync_status, pagerduty_sync_error, reverse_sync_pr_number, reverse_sync_pr_url, reverse_sync_pr_status, reverse_sync_branch, reverse_sync_created_at, reverse_sync_merged_at, reverse_sync_error, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: "Unable to update incident.", detail: error.message }, { status: 500 });
  return NextResponse.json(toIncident(data));
}
