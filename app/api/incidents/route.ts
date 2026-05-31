import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function toIncident(row: any) {
  return {
    id: row.id,
    source: row.alert_source,
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
    acknowledgedAt: row.acknowledged_at ?? null,
    acknowledgedBy: row.acknowledged_by ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolutionNote: row.resolution_note ?? null,
    rejectedAt: row.rejected_at ?? null,
    rejectionReason: row.rejection_reason ?? null,
    externalId: row.external_id ?? null,
    reverseSyncPrNumber: row.reverse_sync_pr_number ?? null,
    reverseSyncPrUrl: row.reverse_sync_pr_url ?? null,
    reverseSyncPrStatus: row.reverse_sync_pr_status ?? null,
    reverseSyncBranch: row.reverse_sync_branch ?? null,
    reverseSyncCreatedAt: row.reverse_sync_created_at ?? null,
    reverseSyncMergedAt: row.reverse_sync_merged_at ?? null,
    reverseSyncError: row.reverse_sync_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at
  };
}

async function getUserOr401(request?: Request, body?: any) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user: authUser }
  } = await supabase.auth.getUser();

  const internalUserId = body?.internalUserId || request?.headers.get("X-Internal-User-Id");
  const user = authUser || (internalUserId ? { id: internalUserId, email: null } : null);
  const isInternalCall = !authUser && !!internalUserId;

  return { supabase, user, isInternalCall };
}

export async function GET(request: Request) {
  const { supabase, user, isInternalCall } = await getUserOr401(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = isInternalCall ? getSupabaseAdminClient() : supabase;

  const { data, error } = await db
    .from("incidents")
    .select("id, alert_source, status, title, repo_full_name, environment, service, severity, branch, commit_sha, release_version, raw_logs, root_cause, ai_fix_proposal, postmortem_draft, ai_analysis, hotfix_branch, hotfix_base_branch, hotfix_pr_number, hotfix_pr_url, hotfix_pr_status, hotfix_merge_sha, hotfix_commits, fix_approved_at, external_id, acknowledged_at, acknowledged_by, resolved_at, resolution_note, rejected_at, rejection_reason, reverse_sync_pr_number, reverse_sync_pr_url, reverse_sync_pr_status, reverse_sync_branch, reverse_sync_created_at, reverse_sync_merged_at, reverse_sync_error, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: "Unable to load incidents.", detail: error.message }, { status: 500 });
  return NextResponse.json((data ?? []).map(toIncident));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { supabase, user, isInternalCall } = await getUserOr401(request, body);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = isInternalCall ? getSupabaseAdminClient() : supabase;

  const logs = String(body.logs ?? "").trim();
  if (!logs) return NextResponse.json({ error: "logs are required" }, { status: 400 });

  // Get user's connected repo if not specified
  let repoFullName = body.repo ?? null;
  if (!repoFullName) {
    const { data: repos } = await db
      .from("repos")
      .select("full_name")
      .eq("user_id", user.id)
      .order("connected_at", { ascending: false })
      .limit(1);

    if (repos?.length) {
      repoFullName = repos[0].full_name;
    }
  }

  const { data, error } = await db
    .from("incidents")
    .insert({
      user_id: user.id,
      alert_source: body.source ?? "manual",
      status: "open",
      title: body.title ?? "Manual incident",
      repo_full_name: repoFullName,
      environment: body.environment ?? "production",
      service: body.service || null,
      severity: body.severity ?? "high",
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
  const body = await request.json().catch(() => ({}));
  const { supabase, user, isInternalCall } = await getUserOr401(request, body);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = isInternalCall ? getSupabaseAdminClient() : supabase;

  const id = String(body.id ?? "");
  const action = String(body.action ?? "").trim();

  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { data: existing, error: existingError } = await db
    .from("incidents")
    .select("id, alert_source, external_id, status")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (existingError) return NextResponse.json({ error: "Unable to load incident.", detail: existingError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Incident not found" }, { status: 404 });

  // Build update payload based on action
  const updates: Record<string, any> = {
    updated_at: new Date().toISOString()
  };

  // Handle specific actions
  if (action === "acknowledge") {
    if (existing.status !== "open") {
      return NextResponse.json({ error: "Can only acknowledge open incidents" }, { status: 400 });
    }
    updates.status = "investigating";
    updates.acknowledged_at = new Date().toISOString();
    updates.acknowledged_by = user.email ?? user.id;
  } else if (action === "resolve") {
    updates.status = "resolved";
    updates.resolved_at = new Date().toISOString();
    updates.resolution_note = body.note ?? body.resolutionNote ?? "Resolved by user";
  } else if (action === "reject") {
    updates.status = "rejected";
    updates.rejected_at = new Date().toISOString();
    updates.rejection_reason = body.note ?? body.rejectionReason ?? "Rejected as not actionable";
  } else {
    // Legacy update path - update individual fields
    if (body.status) updates.status = body.status;
    if (body.rootCause !== undefined) updates.root_cause = body.rootCause;
    if (body.fixProposal !== undefined) updates.ai_fix_proposal = body.fixProposal;
    if (body.postmortem !== undefined) updates.postmortem_draft = body.postmortem;
    if (body.aiAnalysis !== undefined) updates.ai_analysis = body.aiAnalysis;
    if (body.hotfixCommits !== undefined) updates.hotfix_commits = body.hotfixCommits;
  }

  const { data, error } = await db
    .from("incidents")
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, alert_source, status, title, repo_full_name, environment, service, severity, branch, commit_sha, release_version, raw_logs, root_cause, ai_fix_proposal, postmortem_draft, ai_analysis, hotfix_branch, hotfix_base_branch, hotfix_pr_number, hotfix_pr_url, hotfix_pr_status, hotfix_merge_sha, hotfix_commits, fix_approved_at, external_id, acknowledged_at, acknowledged_by, resolved_at, resolution_note, rejected_at, rejection_reason, reverse_sync_pr_number, reverse_sync_pr_url, reverse_sync_pr_status, reverse_sync_branch, reverse_sync_created_at, reverse_sync_merged_at, reverse_sync_error, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: "Unable to update incident.", detail: error.message }, { status: 500 });
  return NextResponse.json(toIncident(data));
}
