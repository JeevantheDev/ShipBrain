import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function toRun(row: any) {
  const plan = row.decomposed_tasks ?? {};
  return {
    id: row.id,
    repo: row.repo_full_name ?? "JeevantheDev/shipbrain_sandbox",
    spec: row.raw_spec,
    branchName: row.branch_name ?? plan.suggestedBranch ?? "",
    baseBranch: row.base_branch ?? "develop",
    result: {
      ...plan,
      scaffold: row.scaffold_code ?? plan.scaffold ?? {},
      pr: row.pr_number
        ? {
            number: row.pr_number,
            html_url: row.pr_url,
            draft: true
          }
        : undefined
    },
    status: row.status,
    ciStatus: row.ci_status ?? undefined,
    ciConclusion: row.ci_conclusion ?? undefined,
    latestCiRunId: row.latest_ci_run_id ? String(row.latest_ci_run_id) : undefined,
    featureHeadSha: row.feature_head_sha ?? undefined,
    featureLastSyncedAt: row.feature_last_synced_at ?? undefined,
    deploymentStatus: row.deployment_status ?? "not_requested",
    deploymentApprovedAt: row.deployment_approved_at ?? undefined,
    releaseTag: row.release_tag ?? undefined,
    releaseStatus: row.release_status ?? "not_started",
    releaseSha: row.release_sha ?? undefined,
    mergeSha: row.merge_sha ?? undefined,
    deploymentRunId: row.deployment_run_id ? String(row.deployment_run_id) : undefined,
    deploymentUrl: row.deployment_url ?? undefined,
    previewUrl: row.preview_url ?? undefined,
    previewStatus: row.preview_status ?? undefined,
    previewBranchAlias: row.preview_branch_alias ?? undefined,
    releasePrNumber: row.release_pr_number ?? undefined,
    releasePrUrl: row.release_pr_url ?? undefined,
    releasePrStatus: row.release_pr_status ?? undefined,
    mergeableState: row.mergeable_state ?? undefined,
    hasMergeConflicts: row.has_merge_conflicts ?? false,
    mergedAt: row.merged_at ?? undefined,
    deployedAt: row.deployed_at ?? undefined,
    updatedAt: row.updated_at ?? row.created_at,
    error: row.error_message ?? undefined
  };
}

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

async function withPullRequestMergeState(rows: any[]) {
  const octokit = getOctokit();
  const enriched = await Promise.allSettled(rows.map(async (row) => {
    if (!row.repo_full_name || !row.pr_number || row.status === "closed" || row.status === "merged") return row;
    try {
      const { owner, repo } = splitRepo(row.repo_full_name);
      const { data: pull } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: row.pr_number
      });
      const mergeableState = pull.mergeable_state ?? null;
      return {
        ...row,
        mergeable_state: mergeableState,
        has_merge_conflicts: mergeableState === "dirty" || pull.mergeable === false
      };
    } catch {
      return row;
    }
  }));

  return enriched.map((result, index) => result.status === "fulfilled" ? result.value : rows[index]);
}

async function getUserOr401() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return { supabase, user };
}

type SupabaseServerClient = ReturnType<typeof getSupabaseServerClient>;
type AuthUser = {
  id: string;
  user_metadata?: Record<string, any>;
};

async function ensureProfile(supabase: SupabaseServerClient, user: AuthUser) {
  await supabase.from("profiles").upsert({
    id: user.id,
    github_login: user.user_metadata?.user_name ?? user.user_metadata?.preferred_username ?? null,
    avatar_url: user.user_metadata?.avatar_url ?? null
  });
}

export async function GET() {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("specs")
    .select("id, raw_spec, decomposed_tasks, scaffold_code, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, ci_status, ci_conclusion, latest_ci_run_id, feature_head_sha, feature_last_synced_at, deployment_status, deployment_approved_at, release_tag, release_status, release_sha, merge_sha, deployment_run_id, deployment_url, preview_url, preview_status, preview_branch_alias, release_pr_number, release_pr_url, release_pr_status, merged_at, deployed_at, error_message, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(5);

  if (error) {
    return NextResponse.json(
      {
        error: "Recent PR history is not ready yet.",
        detail: "Apply Supabase migrations 001_initial.sql and 002_spec_runs_resume.sql, then refresh."
      },
      { status: 500 }
    );
  }

  const enriched = await withPullRequestMergeState(data ?? []);
  return NextResponse.json(enriched.map(toRun));
}

export async function POST(request: Request) {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  await ensureProfile(supabase, user);
  const result = body.result ?? {};
  const { data, error } = await supabase
    .from("specs")
    .insert({
      user_id: user.id,
      raw_spec: body.spec,
      decomposed_tasks: result,
      scaffold_code: result.scaffold ?? {},
      status: body.status ?? "pending_pr",
      repo_full_name: body.repo,
      branch_name: body.branchName ?? result.suggestedBranch,
      base_branch: body.baseBranch ?? "develop",
      error_message: body.error ?? null,
      pr_number: result.pr?.number ?? null,
      pr_url: result.pr?.html_url ?? null,
      updated_at: new Date().toISOString()
    })
    .select("id, raw_spec, decomposed_tasks, scaffold_code, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, ci_status, ci_conclusion, latest_ci_run_id, feature_head_sha, feature_last_synced_at, deployment_status, deployment_approved_at, release_tag, release_status, release_sha, merge_sha, deployment_run_id, deployment_url, preview_url, preview_status, preview_branch_alias, release_pr_number, release_pr_url, release_pr_status, merged_at, deployed_at, error_message, created_at, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: "Unable to save recent PR history.", detail: error.message }, { status: 500 });
  }

  return NextResponse.json(toRun(data));
}

export async function PATCH(request: Request) {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = body.result ?? {};
  const { data, error } = await supabase
    .from("specs")
    .update({
      decomposed_tasks: result,
      scaffold_code: result.scaffold ?? {},
      status: body.status,
      branch_name: body.branchName ?? result.suggestedBranch,
      base_branch: body.baseBranch ?? "develop",
      error_message: body.error ?? null,
      pr_number: result.pr?.number ?? null,
      pr_url: result.pr?.html_url ?? null,
      updated_at: new Date().toISOString()
    })
    .eq("id", body.id)
    .eq("user_id", user.id)
    .select("id, raw_spec, decomposed_tasks, scaffold_code, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, ci_status, ci_conclusion, latest_ci_run_id, feature_head_sha, feature_last_synced_at, deployment_status, deployment_approved_at, release_tag, release_status, release_sha, merge_sha, deployment_run_id, deployment_url, preview_url, preview_status, preview_branch_alias, release_pr_number, release_pr_url, release_pr_status, merged_at, deployed_at, error_message, created_at, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: "Unable to update recent PR history.", detail: error.message }, { status: 500 });
  }

  return NextResponse.json(toRun(data));
}

export async function DELETE(request: Request) {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { error } = await supabase
    .from("specs")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: "Unable to delete recent PR history.", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
