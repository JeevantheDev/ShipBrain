import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { dispatchDevelopPreviewDeploy } from "@/lib/github/deployments";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findDispatchedPreviewRun(input: {
  owner: string;
  repo: string;
  workflowId: string;
  dispatchedAfter: number;
  defaultBranch: string;
}) {
  const octokit = getOctokit();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await wait(900);
    const { data } = await octokit.actions.listWorkflowRuns({
      owner: input.owner,
      repo: input.repo,
      workflow_id: input.workflowId,
      event: "workflow_dispatch",
      per_page: 10
    });

    const run = (data.workflow_runs ?? []).find((workflowRun: any) => {
      const createdAt = new Date(workflowRun.created_at ?? workflowRun.run_started_at ?? 0).getTime();
      return createdAt >= input.dispatchedAfter - 5000 &&
        (!workflowRun.head_branch || workflowRun.head_branch === input.defaultBranch || workflowRun.head_branch === "develop");
    });

    if (run) return run;
  }

  return null;
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user: authUser }
  } = await supabase.auth.getUser();

  const body = await request.json();

  // Support internal server-to-server calls with internalUserId
  const internalUserId = body.internalUserId || request.headers.get("X-Internal-User-Id");
  const user = authUser || (internalUserId ? { id: internalUserId } : null);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const specId = String(body.specId ?? "");
  if (!specId) {
    return NextResponse.json({ error: "specId is required" }, { status: 400 });
  }

  const { data: spec, error: specError } = await supabase
    .from("specs")
    .select("id, status, repo_full_name, branch_name, base_branch, pr_number, merge_sha, deployment_status, preview_status, preview_url")
    .eq("id", specId)
    .eq("user_id", user.id)
    .single();

  if (specError || !spec) {
    return NextResponse.json({ error: "Spec not found.", detail: specError?.message }, { status: 404 });
  }

  if (spec.status !== "merged") {
    return NextResponse.json(
      { error: "Spec must be merged before starting preview deployment.", detail: `Current status: ${spec.status}` },
      { status: 409 }
    );
  }

  if (spec.base_branch !== "develop") {
    return NextResponse.json(
      { error: "Preview deployment is only available for PRs merged to develop.", detail: `Base branch: ${spec.base_branch}` },
      { status: 409 }
    );
  }

  if (spec.preview_status === "deploying") {
    return NextResponse.json(
      { error: "Preview deployment is already in progress.", detail: "Wait for the current deployment to complete." },
      { status: 409 }
    );
  }

  if (spec.preview_url) {
    return NextResponse.json(
      { error: "Preview is already deployed.", detail: `Preview URL: ${spec.preview_url}` },
      { status: 409 }
    );
  }

  const { owner, repo } = splitRepo(spec.repo_full_name);

  try {
    const dispatchedAfter = Date.now();
    const { data: repoRow } = await supabase
      .from("repos")
      .select("default_branch")
      .eq("full_name", spec.repo_full_name)
      .single();

    const defaultBranch = repoRow?.default_branch || "main";

    const deployment = await dispatchDevelopPreviewDeploy({
      owner,
      repo,
      ref: "develop",
      defaultBranch,
      sourcePrNumber: spec.pr_number
    });

    const workflowRun = await findDispatchedPreviewRun({
      owner,
      repo,
      workflowId: deployment.workflowId,
      dispatchedAfter,
      defaultBranch
    });

    await supabase
      .from("specs")
      .update({
        deployment_status: "develop_validated",
        preview_status: "deploying",
        latest_ci_run_id: workflowRun?.id ?? null,
        ci_status: workflowRun?.status ?? "queued",
        ci_conclusion: workflowRun?.conclusion ?? null,
        feature_last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", spec.id);

    if (workflowRun?.id) {
      await supabase
        .from("ci_runs")
        .upsert(
          {
            github_run_id: workflowRun.id,
            spec_id: spec.id,
            pr_number: spec.pr_number ?? null,
            repo_full_name: spec.repo_full_name,
            workflow_name: workflowRun.name ?? deployment.workflowId,
            title: workflowRun.display_title ?? workflowRun.name ?? `Workflow run #${workflowRun.id}`,
            html_url: workflowRun.html_url ?? null,
            head_sha: workflowRun.head_sha ?? spec.merge_sha ?? null,
            event: workflowRun.event ?? "workflow_dispatch",
            branch: deployment.ref,
            environment: "preview",
            status: workflowRun.status ?? "queued",
            conclusion: workflowRun.conclusion ?? null,
            updated_at: new Date().toISOString()
          },
          { onConflict: "github_run_id" }
        );
    }

    await supabase.from("approval_events").insert({
      entity_type: "spec",
      entity_id: spec.id,
      action: "deploy_approved",
      actor_id: user.id,
      note: "Started preview deployment from Deployment Queue",
      metadata: {
        specId: spec.id,
        repo: spec.repo_full_name,
        branch: "develop",
        prNumber: spec.pr_number,
        workflowUrl: deployment.workflowUrl,
        approvedFor: "develop preview deployment"
      }
    });

    // Create notification for preview deployment
    await supabase
      .from("notifications")
      .insert({
        user_id: user.id,
        type: "preview_deploy_started",
        title: "Preview Deployment Started",
        body: `Deploying PR #${spec.pr_number} to preview environment`,
        href: deployment.workflowUrl,
        severity: "info",
        repo_full_name: spec.repo_full_name,
        metadata: { specId: spec.id, prNumber: spec.pr_number, branch: "develop" }
      })
      .catch((err) => console.error("notification creation failed", err));

    return NextResponse.json({
      ok: true,
      workflowUrl: deployment.workflowUrl,
      ciRunId: workflowRun?.id ? String(workflowRun.id) : null,
      ciRunUrl: workflowRun?.html_url ?? null,
      message: "Preview deployment started. The preview URL will appear after GitHub Actions completes."
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start preview deployment.",
        detail: error instanceof Error ? error.message : "GitHub workflow dispatch failed."
      },
      { status: 500 }
    );
  }
}
