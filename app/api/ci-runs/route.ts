import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function toCiRun(row: any) {
  const title = row.title ?? row.workflow_name ?? `Workflow run #${row.github_run_id}`;
  const isPreviewRun =
    row.environment === "preview" ||
    String(row.workflow_name ?? row.title ?? "").toLowerCase().includes("preview") ||
    row.specs?.preview_status === "deploying" ||
    row.specs?.preview_status === "deployed";
  const displayBranch = isPreviewRun ? row.specs?.base_branch ?? "develop" : row.branch ?? "unknown";
  const isIncidentHotfix = Boolean(row.specs?.incident_id);
  const isReleasePromotionPr =
    !isIncidentHotfix &&
    displayBranch === "develop" &&
    row.conclusion === "success" &&
    row.specs?.branch_name === "develop" &&
    row.specs?.base_branch === "main" &&
    Boolean(row.specs?.pr_number) &&
    row.specs?.release_pr_status !== "merged" &&
    !["deploying", "deployed"].includes(row.specs?.release_status ?? "not_started");
  const isFeatureDevelopGate =
    !isIncidentHotfix &&
    displayBranch === "develop" &&
    row.conclusion === "success" &&
    row.specs?.status === "merged" &&
    (row.specs?.release_status === "ready_for_prod" || row.specs?.release_status === "not_started") &&
    !row.specs?.release_pr_number;
  const deploymentEligible = isReleasePromotionPr || isFeatureDevelopGate;
  const logs = [
    `Workflow: ${row.workflow_name ?? "Unknown workflow"}`,
    `Repository: ${row.repo_full_name ?? "Unknown repository"}`,
    `Branch: ${displayBranch}`,
    `Status: ${row.status}`,
    `Conclusion: ${row.conclusion ?? "pending"}`,
    `Commit: ${row.head_sha ?? "unknown"}`,
    row.html_url ? `GitHub URL: ${row.html_url}` : null
  ].filter(Boolean).join("\n");

  return {
    id: String(row.github_run_id),
    databaseId: row.id,
    specId: row.spec_id ?? undefined,
    specStatus: row.specs?.status ?? undefined,
    prNumber: row.pr_number ?? undefined,
    prUrl: row.specs?.pr_url ?? undefined,
    sourceBranch: row.specs?.branch_name ?? undefined,
    destinationBranch: row.specs?.base_branch ?? undefined,
    specTitle: row.specs?.decomposed_tasks?.prTitle ?? undefined,
    deploymentStatus: row.specs?.deployment_status ?? "not_requested",
    releaseTag: row.specs?.release_tag ?? undefined,
    releaseStatus: row.specs?.release_status ?? "not_started",
    deploymentUrl: row.specs?.deployment_url ?? undefined,
    previewUrl: row.specs?.preview_url ?? row.preview_url ?? undefined,
    previewStatus: row.specs?.preview_status ?? undefined,
    previewBranchAlias: row.specs?.preview_branch_alias ?? row.branch_alias ?? undefined,
    releasePrNumber: row.specs?.release_pr_number ?? undefined,
    releasePrUrl: row.specs?.release_pr_url ?? undefined,
    releasePrStatus: row.specs?.release_pr_status ?? undefined,
    releasePromotionPrNumber: isReleasePromotionPr ? row.specs?.pr_number ?? undefined : undefined,
    releasePromotionPrUrl: isReleasePromotionPr ? row.specs?.pr_url ?? undefined : undefined,
    isReleasePromotionPr,
    incidentId: row.specs?.incident_id ?? undefined,
    incidentTitle: row.specs?.incidents?.title ?? undefined,
    incidentStatus: row.specs?.incidents?.status ?? undefined,
    incidentHotfixPrUrl: row.specs?.incidents?.hotfix_pr_url ?? undefined,
    incidentHotfixPrNumber: row.specs?.incidents?.hotfix_pr_number ?? undefined,
    isIncidentHotfix,
    deploymentEligible,
    repo: row.repo_full_name,
    branch: displayBranch,
    status: row.status,
    conclusion: row.conclusion,
    title,
    workflowName: row.workflow_name,
    htmlUrl: row.html_url,
    headSha: row.head_sha,
    event: row.event,
    updatedAt: row.updated_at ?? row.created_at,
    logs
  };
}

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

async function reconcileProductionDeployments(supabase: ReturnType<typeof getSupabaseAdminClient>, userId: string) {
  const { data: specs } = await supabase
    .from("specs")
    .select("id, user_id, repo_full_name, pr_number, release_tag, release_sha, release_status")
    .eq("user_id", userId)
    .eq("release_status", "deploying")
    .not("release_tag", "is", null)
    .not("repo_full_name", "is", null)
    .order("updated_at", { ascending: false })
    .limit(5);

  if (!specs?.length) return;

  const octokit = getOctokit();
  await Promise.allSettled(specs.map(async (spec: any) => {
    if (!spec.repo_full_name || !spec.release_tag) return;
    const { owner, repo } = splitRepo(spec.repo_full_name);

    // Try new workflow name first, then fall back to old names
    const workflowNames = ["shipbrain-production.yml", "shipbrain-deploy.yml", "shipbrain-vercel-prod.yml"];
    let data: { workflow_runs?: any[] } = { workflow_runs: [] };

    for (const workflowName of workflowNames) {
      try {
        const result = await octokit.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: workflowName,
          per_page: 20
        });
        if (result.data.workflow_runs?.length) {
          data = result.data;
          break;
        }
      } catch {
        // Workflow not found, try next
        continue;
      }
    }

    const runs = (data.workflow_runs ?? []).filter((run: any) =>
      run.head_branch === spec.release_tag ||
      (spec.release_sha && run.head_sha === spec.release_sha) ||
      (run.display_title ?? "").includes(spec.release_tag)
    );
    if (!runs.length) return;

    const successRun = runs.find((run: any) => run.status === "completed" && run.conclusion === "success");
    const failedRun = runs.find((run: any) => run.status === "completed" && run.conclusion && run.conclusion !== "success");
    const activeRun = runs.find((run: any) => run.status !== "completed");
    const run = successRun ?? failedRun ?? activeRun ?? runs[0];
    const nextReleaseStatus =
      run.status === "completed"
        ? run.conclusion === "success"
          ? "deployed"
          : "failed"
        : "deploying";

    await supabase
      .from("ci_runs")
      .upsert(
        {
          github_run_id: run.id,
          spec_id: spec.id,
          pr_number: spec.pr_number ?? null,
          repo_full_name: spec.repo_full_name,
          workflow_name: run.name ?? "ShipBrain Vercel Production Deploy",
          title: run.display_title ?? run.name ?? `Workflow run #${run.id}`,
          html_url: run.html_url ?? null,
          head_sha: run.head_sha ?? null,
          event: run.event ?? null,
          branch: run.head_branch ?? spec.release_tag,
          status: run.status ?? "queued",
          conclusion: run.conclusion ?? null,
          updated_at: new Date().toISOString()
        },
        { onConflict: "github_run_id" }
      );

    await supabase
      .from("specs")
      .update({
        deployment_run_id: run.id,
        deployment_url: run.html_url ?? null,
        release_status: nextReleaseStatus,
        deployed_at: nextReleaseStatus === "deployed" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);
  }));
}

async function reconcileOpenPrWorkflowRuns(supabase: ReturnType<typeof getSupabaseAdminClient>, userId: string) {
  const { data: specs } = await supabase
    .from("specs")
    .select("id, repo_full_name, pr_number")
    .eq("user_id", userId)
    .not("repo_full_name", "is", null)
    .not("pr_number", "is", null)
    .in("status", ["draft_created", "pending_pr"])
    .order("updated_at", { ascending: false })
    .limit(5);

  if (!specs?.length) return;

  const octokit = getOctokit();
  await Promise.allSettled(specs.map(async (spec: any) => {
    if (!spec.repo_full_name || !spec.pr_number) return;
    const { owner, repo } = splitRepo(spec.repo_full_name);
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 20
    });
    const run = (data.workflow_runs ?? []).find((workflowRun) =>
      (workflowRun.pull_requests ?? []).some((pullRequest) => pullRequest.number === spec.pr_number)
    );
    if (!run) return;

    await supabase
      .from("ci_runs")
      .upsert(
        {
          github_run_id: run.id,
          spec_id: spec.id,
          pr_number: spec.pr_number,
          repo_full_name: spec.repo_full_name,
          workflow_name: run.name ?? null,
          title: run.display_title ?? run.name ?? `Workflow run #${run.id}`,
          html_url: run.html_url ?? null,
          head_sha: run.head_sha ?? null,
          event: run.event ?? null,
          branch: run.head_branch ?? null,
          status: run.status ?? "queued",
          conclusion: run.conclusion ?? null,
          updated_at: new Date().toISOString()
        },
        { onConflict: "github_run_id" }
      );

    await supabase
      .from("specs")
      .update({
        ci_status: run.status ?? "queued",
        ci_conclusion: run.conclusion ?? null,
        latest_ci_run_id: run.id,
        feature_head_sha: run.head_sha ?? null,
        feature_last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);
  }));
}

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Parse pagination params
  const url = new URL(request.url);
  const requestedRunId = url.searchParams.get("run");
  const repoFilter = url.searchParams.get("repo"); // Filter by repo_full_name
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(5, parseInt(url.searchParams.get("limit") ?? "10", 10)));
  const offset = (page - 1) * limit;

  const admin = getSupabaseAdminClient();
  await reconcileProductionDeployments(admin, user.id);
  await reconcileOpenPrWorkflowRuns(admin, user.id);

  if (requestedRunId) {
    const numericRunId = Number(requestedRunId);
    if (!Number.isFinite(numericRunId)) {
      return NextResponse.json({ error: "Invalid CI run id." }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("ci_runs")
      .select("id, github_run_id, spec_id, pr_number, repo_full_name, workflow_name, title, html_url, head_sha, event, branch, status, conclusion, environment, preview_url, branch_alias, created_at, updated_at, specs(status, incident_id, decomposed_tasks, branch_name, base_branch, pr_number, pr_url, deployment_status, release_tag, release_status, deployment_url, preview_url, preview_status, preview_branch_alias, release_pr_number, release_pr_url, release_pr_status, incidents(id, title, status, hotfix_pr_number, hotfix_pr_url))")
      .eq("github_run_id", numericRunId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: "Unable to load CI run.", detail: error.message }, { status: 500 });
    }

    return NextResponse.json({
      runs: data ? [toCiRun(data)] : [],
      pagination: {
        page: 1,
        limit: 1,
        total: data ? 1 : 0,
        totalPages: data ? 1 : 0
      }
    });
  }

  // Get total count (filtered by repo if specified)
  let countQuery = supabase
    .from("ci_runs")
    .select("id", { count: "exact", head: true });
  if (repoFilter) {
    countQuery = countQuery.eq("repo_full_name", repoFilter);
  }
  const { count } = await countQuery;

  let dataQuery = supabase
    .from("ci_runs")
    .select("id, github_run_id, spec_id, pr_number, repo_full_name, workflow_name, title, html_url, head_sha, event, branch, status, conclusion, environment, preview_url, branch_alias, created_at, updated_at, specs(status, incident_id, decomposed_tasks, branch_name, base_branch, pr_number, pr_url, deployment_status, release_tag, release_status, deployment_url, preview_url, preview_status, preview_branch_alias, release_pr_number, release_pr_url, release_pr_status, incidents(id, title, status, hotfix_pr_number, hotfix_pr_url))")
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (repoFilter) {
    dataQuery = dataQuery.eq("repo_full_name", repoFilter);
  }
  const { data, error } = await dataQuery;

  if (error) {
    return NextResponse.json({ error: "Unable to load CI runs.", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({
    runs: (data ?? []).map(toCiRun),
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit)
    }
  });
}
