import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { dispatchDevelopPreviewDeploy, dispatchCloudflareProductionDeploy, createReleaseTag } from "@/lib/github/deployments";
import { getOctokit } from "@/lib/github/client";
import { createOrUpdateTrace } from "@/lib/orchestrator";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

/**
 * Trigger initial preview and production deployments after repo onboarding.
 * This creates an initial v1.0.0 release so users can verify the system works.
 *
 * Called internally when setup PR is merged.
 */
export async function POST(request: Request) {
  const body = await request.json();
  const db = getSupabaseAdminClient();

  const repoFullName = String(body.repoFullName ?? "");
  const userId = String(body.userId ?? "");
  const setupPrNumber = body.setupPrNumber ? Number(body.setupPrNumber) : null;

  if (!repoFullName || !userId) {
    return NextResponse.json({ error: "repoFullName and userId are required" }, { status: 400 });
  }

  const { owner, repo } = splitRepo(repoFullName);

  // Get repo config and user's GitHub token
  const { data: repoRow, error: repoError } = await db
    .from("repos")
    .select("id, default_branch, setup_metadata, telegram_notifications_enabled")
    .eq("full_name", repoFullName)
    .eq("user_id", userId)
    .single();

  if (repoError || !repoRow) {
    return NextResponse.json({ error: "Repo not found.", detail: repoError?.message }, { status: 404 });
  }

  const { data: profile } = await db
    .from("profiles")
    .select("github_access_token, github_login")
    .eq("id", userId)
    .single();

  const userGitHubToken = profile?.github_access_token;
  if (!userGitHubToken) {
    return NextResponse.json({ error: "GitHub not connected for user." }, { status: 409 });
  }

  const octokit = getOctokit(userGitHubToken);
  const setupMetadata = repoRow.setup_metadata as Record<string, any> ?? {};
  const prodBranch = setupMetadata.prodBranch || repoRow.default_branch || "main";
  const devBranch = setupMetadata.devBranch || "develop";

  // Get the latest commit SHA from main branch for release tag
  let mainSha: string;
  try {
    const { data: mainRef } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${prodBranch}`
    });
    mainSha = mainRef.object.sha;
  } catch (error) {
    return NextResponse.json({
      error: "Failed to get main branch SHA.",
      detail: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }

  const results: {
    previewDeployment?: any;
    productionDeployment?: any;
    releaseTag?: any;
    spec?: any;
    traces?: any[];
    errors: string[];
  } = {
    errors: []
  };

  // Create an "onboarding" spec to track this initial deployment
  const releaseTag = "v1.0.0";
  const now = new Date().toISOString();

  const { data: spec, error: specError } = await db
    .from("specs")
    .insert({
      user_id: userId,
      raw_spec: `Initial ShipBrain deployment for ${repoFullName}`,
      decomposed_tasks: {
        type: "onboarding",
        prTitle: `Initial Release ${releaseTag}`,
        setupPrNumber,
        releaseTag
      },
      status: "merged",
      repo_full_name: repoFullName,
      branch_name: prodBranch,
      base_branch: prodBranch,
      pr_number: setupPrNumber,
      pr_url: setupPrNumber ? `https://github.com/${repoFullName}/pull/${setupPrNumber}` : null,
      merged_at: now,
      merge_sha: mainSha,
      feature_head_sha: mainSha,
      release_tag: releaseTag,
      release_sha: mainSha,
      release_status: "deploying",
      preview_status: "deploying",
      updated_at: now
    })
    .select("id")
    .single();

  if (specError || !spec) {
    results.errors.push(`Failed to create spec: ${specError?.message ?? "Unknown error"}`);
  } else {
    results.spec = spec;
  }

  // Step 1: Create release tag v1.0.0
  try {
    const tagResult = await createReleaseTag({
      owner,
      repo,
      tag: releaseTag,
      sha: mainSha,
      message: `Initial ShipBrain release - ${releaseTag}`,
      token: userGitHubToken
    });
    results.releaseTag = tagResult;
  } catch (error: any) {
    // Tag might already exist if this is a re-run
    if (error.status !== 422 && !error.message?.includes("already exists")) {
      results.errors.push(`Failed to create release tag: ${error.message}`);
    }
  }

  // Step 2: Trigger preview deployment for develop branch
  try {
    const previewResult = await dispatchDevelopPreviewDeploy({
      owner,
      repo,
      ref: devBranch,
      defaultBranch: prodBranch,
      sourcePrNumber: setupPrNumber,
      token: userGitHubToken
    });
    results.previewDeployment = previewResult;

    // Update spec with preview status
    if (spec?.id) {
      await db.from("specs").update({
        preview_status: "deploying",
        updated_at: new Date().toISOString()
      }).eq("id", spec.id);
    }
  } catch (error: any) {
    results.errors.push(`Preview deployment failed: ${error.message}`);
  }

  // Step 3: Trigger production deployment with v1.0.0
  try {
    const productionResult = await dispatchCloudflareProductionDeploy({
      owner,
      repo,
      releaseTag,
      releaseSha: mainSha,
      token: userGitHubToken
    });
    results.productionDeployment = productionResult;

    // Update spec with production status
    if (spec?.id) {
      await db.from("specs").update({
        release_status: "deploying",
        deployment_url: productionResult.workflowUrl,
        updated_at: new Date().toISOString()
      }).eq("id", spec.id);
    }
  } catch (error: any) {
    results.errors.push(`Production deployment failed: ${error.message}`);
  }

  // Step 4: Create release traces for tracking
  const traces: any[] = [];

  // Preview trace (develop deployment) - no specId to keep it separate from production trace
  try {
    const previewTrace = await createOrUpdateTrace({
      repoFullName,
      type: "feature",
      title: "Initial Preview Deployment",
      description: `ShipBrain onboarding - initial preview deployment from ${devBranch}`,
      status: "preview_live",
      sourceBranch: devBranch,
      targetBranch: devBranch,
      source: "system",
      actor: profile?.github_login ?? "ShipBrain",
      eventType: "preview_deployed",
      details: {
        type: "onboarding",
        environment: "preview",
        workflowUrl: results.previewDeployment?.workflowUrl
      }
    });
    if (previewTrace) traces.push(previewTrace);
  } catch (error: any) {
    results.errors.push(`Preview trace creation failed: ${error.message}`);
  }

  // Production trace (v1.0.0 deployment)
  try {
    const productionTrace = await createOrUpdateTrace({
      repoFullName,
      type: "release",
      title: `Release ${releaseTag}`,
      description: `ShipBrain onboarding - initial production deployment`,
      status: "production_live",
      sourceBranch: prodBranch,
      targetBranch: prodBranch,
      specId: spec?.id,
      source: "system",
      actor: profile?.github_login ?? "ShipBrain",
      eventType: "deployment_succeeded",
      details: {
        type: "onboarding",
        environment: "production",
        releaseTag,
        releaseSha: mainSha,
        workflowUrl: results.productionDeployment?.workflowUrl
      }
    });
    if (productionTrace) traces.push(productionTrace);
  } catch (error: any) {
    results.errors.push(`Production trace creation failed: ${error.message}`);
  }

  results.traces = traces;

  // Update repo setup status
  await db.from("repos").update({
    setup_status: "initial_deployment_started",
    updated_at: new Date().toISOString()
  }).eq("id", repoRow.id);

  // Create notifications
  await db.from("notifications").insert([
    {
      user_id: userId,
      type: "initial_preview_deployment",
      title: "Initial Preview Deployment Started",
      body: `Deploying ${devBranch} branch to preview environment`,
      href: results.previewDeployment?.workflowUrl,
      severity: "info",
      repo_full_name: repoFullName,
      metadata: { specId: spec?.id, branch: devBranch }
    },
    {
      user_id: userId,
      type: "initial_production_deployment",
      title: "Initial Production Deployment Started",
      body: `Deploying ${releaseTag} to production`,
      href: results.productionDeployment?.workflowUrl,
      severity: "info",
      repo_full_name: repoFullName,
      metadata: { specId: spec?.id, releaseTag, releaseSha: mainSha }
    }
  ]);

  return NextResponse.json({
    ok: results.errors.length === 0,
    repoFullName,
    releaseTag,
    releaseSha: mainSha,
    previewWorkflowUrl: results.previewDeployment?.workflowUrl ?? null,
    productionWorkflowUrl: results.productionDeployment?.workflowUrl ?? null,
    specId: spec?.id ?? null,
    traces: traces.map(t => t?.id),
    errors: results.errors.length > 0 ? results.errors : undefined,
    message: results.errors.length === 0
      ? `Initial deployments started! Preview deploying from ${devBranch}, production deploying ${releaseTag}`
      : `Initial deployments partially started with ${results.errors.length} errors`
  });
}
