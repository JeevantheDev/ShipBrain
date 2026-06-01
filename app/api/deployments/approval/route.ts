import { NextResponse } from "next/server";
import { dispatchDevelopPreviewDeploy, dispatchVercelProductionDeploy } from "@/lib/github/deployments";
import { ensureReleaseTagAvailable, mergePullRequest, tagCommitForRelease } from "@/lib/github/pr";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type ApprovalAction = "deploy_approved" | "deploy_rejected";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

function defaultReleaseTag() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", ".");
  const random = Math.random().toString(36).substring(2, 6);
  return `shipbrain-v${stamp}-${random}`;
}

function toAudit(row: any) {
  return {
    id: row.id,
    action: row.action,
    note: row.note,
    createdAt: row.created_at,
    metadata: row.metadata ?? {},
    actor: row.profiles ? {
      githubLogin: row.profiles.github_login,
      avatarUrl: row.profiles.avatar_url
    } : null
  };
}

async function getUserOr401(request?: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user: authUser }
  } = await supabase.auth.getUser();

  // Support internal server-to-server calls with X-Internal-User-Id
  const internalUserId = request?.headers.get("X-Internal-User-Id");
  const user = authUser || (internalUserId ? { id: internalUserId, email: null, user_metadata: {} } : null);

  return { supabase, user: user as any };
}

export async function GET(request: Request) {
  const { supabase, user } = await getUserOr401(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isInternalCall = !request.headers.get("cookie") && !!request.headers.get("X-Internal-User-Id");
  const db = isInternalCall ? getSupabaseAdminClient() : supabase;

  const url = new URL(request.url);
  const entityId = url.searchParams.get("entityId");
  const specId = url.searchParams.get("specId");

  let resolvedSpecId = specId;

  // Resolve the specId from entityId if specId is missing
  if (!resolvedSpecId && entityId) {
    const { data: specCheck } = await db
      .from("specs")
      .select("id")
      .eq("id", entityId)
      .maybeSingle();

    if (specCheck) {
      resolvedSpecId = specCheck.id;
    } else {
      const { data: runCheck } = await db
        .from("ci_runs")
        .select("spec_id")
        .eq("github_run_id", entityId)
        .maybeSingle();

      if (runCheck?.spec_id) {
        resolvedSpecId = runCheck.spec_id;
      }
    }
  }

  // 1. Fetch manual approvals/rejections from approval_events
  let approvalQuery = db
    .from("approval_events")
    .select("id, action, note, metadata, created_at, profiles(github_login, avatar_url)")
    .order("created_at", { ascending: false });

  if (resolvedSpecId) {
    approvalQuery = approvalQuery.or(`metadata->>specId.eq.${resolvedSpecId},and(entity_type.eq.spec,entity_id.eq.${resolvedSpecId})`);
  } else if (entityId) {
    approvalQuery = approvalQuery.eq("entity_id", entityId);
  }

  const { data: approvals, error: approvalError } = await approvalQuery;
  if (approvalError) {
    return NextResponse.json({ error: "Unable to load deployment approvals.", detail: approvalError.message }, { status: 500 });
  }

  const auditEvents = (approvals ?? []).map(toAudit);

  // 2. Fetch trace events from release_traces + trace_events if specId is resolved
  let traceAuditEvents: any[] = [];
  if (resolvedSpecId) {
    const { data: releaseTraces } = await db
      .from("release_traces")
      .select("id")
      .eq("spec_id", resolvedSpecId);

    if (releaseTraces && releaseTraces.length > 0) {
      const traceIds = releaseTraces.map((rt: any) => rt.id);

      const { data: events, error: eventsError } = await db
        .from("trace_events")
        .select("id, event_type, details, created_at, actor, actor_type, source")
        .in("trace_id", traceIds);

      if (!eventsError && events) {
        const ALLOWED_LIFECYCLE_EVENTS = new Set([
          "trace_created",
          "pr_merged",
          "preview_deployed",
          "release_pr_created",
          "deployment_succeeded",
          "deployment_failed",
          "incident_linked",
          "hotfix_created",
          "rollback_initiated",
          "rollback_deployed",
          "rollback_failed"
        ]);

        const filteredEvents = events.filter((e: any) => 
          ALLOWED_LIFECYCLE_EVENTS.has(e.event_type) || 
          e.event_type.toLowerCase().includes("rollback")
        );

        traceAuditEvents = filteredEvents.map((e: any) => ({
          id: e.id,
          action: e.event_type,
          note: e.details?.note || e.details?.notes || e.details?.approvedFor || "",
          createdAt: e.created_at,
          metadata: e.details ?? {},
          actor: e.actor ? {
            githubLogin: e.actor,
            avatarUrl: null
          } : null
        }));
      }
    }
  }

  // 3. Merge both sources and sort descending by timestamp
  const unifiedTimeline = [...auditEvents, ...traceAuditEvents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return NextResponse.json(unifiedTimeline.slice(0, 20));
}

export async function POST(request: Request) {
  const { supabase, user } = await getUserOr401(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isInternalCall = !request.headers.get("cookie") && !!request.headers.get("X-Internal-User-Id");
  const db = isInternalCall ? getSupabaseAdminClient() : supabase;

  // Get user's GitHub profile details
  const { data: profile } = await db
    .from("profiles")
    .select("github_access_token, github_login")
    .eq("id", user.id)
    .maybeSingle();
  const userGitHubToken = profile?.github_access_token;

  if (!userGitHubToken) {
    return NextResponse.json(
      { error: "GitHub is not connected.", detail: "Please connect your GitHub account before approving deployments." },
      { status: 409 }
    );
  }

  const body = await request.json();
  let runId = String(body.runId ?? "");
  const action = body.action as ApprovalAction;

  if (action !== "deploy_approved" && action !== "deploy_rejected") {
    return NextResponse.json({ error: "action must be deploy_approved or deploy_rejected" }, { status: 400 });
  }

  // Support mapping traceId/specId to a runId on internal calls
  let specId = body.specId || body.traceId;
  if (body.traceId && !specId) {
    const { data: traceRow } = await db
      .from("release_traces")
      .select("spec_id")
      .eq("id", body.traceId)
      .maybeSingle();
    if (traceRow?.spec_id) {
      specId = traceRow.spec_id;
    }
  }

  if (specId && !runId) {
    // Check if this is a merged release PR that's ready for deployment (no CI run needed)
    const { data: specForDeploy } = await db
      .from("specs")
      .select("id, status, merge_sha, base_branch, branch_name, release_status, release_pr_status, release_pr_number, repo_full_name")
      .eq("id", specId)
      .single();

    // If release PR is merged and pending deploy, we can deploy directly without CI run
    if (
      specForDeploy &&
      specForDeploy.release_pr_status === "merged" &&
      specForDeploy.release_status === "pending_deploy" &&
      specForDeploy.merge_sha
    ) {
      // Direct deployment path - no CI run needed
      const { owner, repo } = splitRepo(specForDeploy.repo_full_name);
      const releaseTag = String(body.releaseTag ?? "").trim() || defaultReleaseTag();

      try {
        const { dispatchCloudflareProductionDeploy } = await import("@/lib/github/deployments");

        await ensureReleaseTagAvailable({
          owner,
          repo,
          sha: specForDeploy.merge_sha,
          releaseTag,
          token: userGitHubToken
        });

        const release = await tagCommitForRelease({
          owner,
          repo,
          sha: specForDeploy.merge_sha,
          releaseTag,
          token: userGitHubToken
        });

        const deployment = await dispatchCloudflareProductionDeploy({
          owner,
          repo,
          releaseTag: release.releaseTag,
          releaseSha: release.sha,
          token: userGitHubToken
        });

        // Update spec
        await db.from("specs").update({
          deployment_status: "approved",
          release_tag: releaseTag,
          release_sha: release.sha,
          release_status: "deploying",
          deployment_url: deployment.workflowUrl,
          updated_at: new Date().toISOString()
        }).eq("id", specId);

        // Log approval event
        await db.from("approval_events").insert({
          entity_type: "spec",
          entity_id: specId,
          action: "deploy_approved",
          actor_id: user.id,
          note: "Production deployment approved (release PR already merged)",
          metadata: {
            releaseTag,
            releaseSha: release.sha,
            workflowUrl: deployment.workflowUrl,
            repo: specForDeploy.repo_full_name
          }
        });

        // Synchronize with release trace
        try {
          const { updateTraceBySpec } = await import("@/lib/orchestrator");
          await updateTraceBySpec(specId, {
            status: "merged_main",
            production_deployment: {
              status: "deploying",
              url: deployment.workflowUrl,
              releaseTag,
              releaseSha: release.sha,
              timestamp: new Date().toISOString()
            }
          }, {
            eventType: "deployment_started",
            source: "manual",
            actor: profile?.github_login ?? user.email ?? "User",
            actorType: "user",
            details: { note: "Production deployment approved (release PR already merged)", releaseTag }
          });
        } catch (traceErr) {
          console.error("Failed to update release trace:", traceErr);
        }

        return NextResponse.json({
          ok: true,
          releaseTag,
          releaseSha: release.sha,
          workflowUrl: deployment.workflowUrl,
          nextStep: "Production deployment in progress"
        });
      } catch (error) {
        return NextResponse.json({
          error: "Failed to start production deployment.",
          detail: error instanceof Error ? error.message : "Unknown error"
        }, { status: 500 });
      }
    }

    // Find the latest CI run for this spec that is successful or running
    const { data: ciRuns, error: ciRunsError } = await db
      .from("ci_runs")
      .select("github_run_id, status, conclusion, branch")
      .eq("spec_id", specId)
      .order("updated_at", { ascending: false });

    if (ciRunsError) {
      return NextResponse.json({ error: "Failed to query CI runs for spec.", detail: ciRunsError.message }, { status: 500 });
    }

    const targetRun = ciRuns?.find(r => r.conclusion === "success") || ciRuns?.[0];
    if (targetRun) {
      runId = String(targetRun.github_run_id);
    } else {
      // If no CI runs but we have a merged spec, try direct deployment
      if (specForDeploy?.status === "merged" && specForDeploy.merge_sha) {
        return NextResponse.json({
          error: "No CI runs found, but spec is merged.",
          detail: "Try using 'Deploy to Production' instead of 'Approve Release' for merged release PRs."
        }, { status: 404 });
      }
      return NextResponse.json({ error: "No workflow runs found for this spec/trace. Please ensure CI has run on GitHub." }, { status: 404 });
    }
  }

  if (!runId) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const githubRunId = Number(runId);
  if (!Number.isFinite(githubRunId)) {
    return NextResponse.json({ error: "runId must be a GitHub workflow run id" }, { status: 400 });
  }

  const { data: ciRun, error: ciError } = await db
    .from("ci_runs")
    .select("github_run_id, spec_id, pr_number, repo_full_name, workflow_name, title, html_url, branch, status, conclusion, head_sha, updated_at, specs(incident_id)")
    .eq("github_run_id", githubRunId)
    .single();

  if (ciError || !ciRun) {
    return NextResponse.json({ error: "CI run was not found. Wait for the GitHub webhook to sync, then retry." }, { status: 404 });
  }

  if (action === "deploy_approved" && ciRun.conclusion !== "success") {
    return NextResponse.json(
      { error: "Deployment approval requires a successful CI run.", detail: `Current conclusion is ${ciRun.conclusion ?? ciRun.status}.` },
      { status: 409 }
    );
  }

  const linkedSpec = Array.isArray(ciRun.specs) ? ciRun.specs[0] : ciRun.specs;
  if (action === "deploy_approved" && linkedSpec?.incident_id) {
    return NextResponse.json(
      {
        error: "Incident hotfix runs are not eligible for Approve Deploy.",
        detail: "Incident hotfix approval already merges the hotfix PR, creates a hotfix release tag, and dispatches the production deployment. Track the linked incident instead."
      },
      { status: 409 }
    );
  }

  // Check if this is a pending deploy scenario (main branch CI run for merged release PR)
  // For pending deploys, we allow approval from the main branch CI run
  let isPendingDeployFromMain = false;
  if (action === "deploy_approved" && ciRun.branch === "main" && ciRun.spec_id) {
    const { data: pendingSpec } = await db
      .from("specs")
      .select("release_status, release_pr_status")
      .eq("id", ciRun.spec_id)
      .single();
    isPendingDeployFromMain = pendingSpec?.release_status === "pending_deploy" && pendingSpec?.release_pr_status === "merged";
  }

  // Only block non-develop branches if this is NOT a pending deploy from main
  if (action === "deploy_approved" && ciRun.branch !== "develop" && !isPendingDeployFromMain) {
    return NextResponse.json(
      {
        error: "This workflow run is not eligible for production approval.",
        detail: "Approve deploy is only available from the green develop validation run for a merged feature PR. Main/release/deployment workflow runs are read-only in ShipBrain."
      },
      { status: 409 }
    );
  }

  await db.from("profiles").upsert({
    id: user.id,
    github_login: user.user_metadata?.user_name ?? user.user_metadata?.preferred_username ?? null,
    avatar_url: user.user_metadata?.avatar_url ?? null
  });

  const note = String(body.note ?? "").trim();
  const releaseTag = String(body.releaseTag ?? "").trim() || defaultReleaseTag();
  let release: Awaited<ReturnType<typeof tagCommitForRelease>> | null = null;
  let deployment: Awaited<ReturnType<typeof dispatchVercelProductionDeploy>> | null = null;
  let previewDeployment: Awaited<ReturnType<typeof dispatchDevelopPreviewDeploy>> | null = null;
  let releaseMerge: Awaited<ReturnType<typeof mergePullRequest>> | null = null;
  let releasePrMode: "create_pr" | "merge_existing_pr" | null = null;
  let spec: any = null;

  if (action === "deploy_approved") {
    if (!ciRun.repo_full_name || !ciRun.pr_number) {
      return NextResponse.json(
        { error: "Deployment approval requires a CI run linked to a ShipBrain Draft PR.", detail: "Create the PR through Spec-to-PR and wait for its CI webhook to sync." },
        { status: 409 }
      );
    }

    const { owner, repo } = splitRepo(ciRun.repo_full_name);
    const { data: specRow, error: specError } = ciRun.spec_id
      ? await db
          .from("specs")
          .select("id, status, merge_sha, base_branch, branch_name, pr_number, pr_url, release_status, release_pr_number, release_pr_url, release_pr_status, preview_url, preview_status, preview_branch_alias")
          .eq("id", ciRun.spec_id)
          .single()
      : { data: null, error: null };

    if (specError || !specRow) {
      return NextResponse.json(
        { error: "ShipBrain could not find the merged Spec-to-PR record for this CI run.", detail: "Refresh CI Monitor and retry after GitHub webhooks finish syncing." },
        { status: 404 }
      );
    }

    spec = specRow;

    // Check if this is a release PR (develop → main) or a feature PR (anything → develop)
    const isReleasePr = spec.branch_name === "develop" && spec.base_branch === "main" && Boolean(spec.pr_number);
    const isFeaturePrToDevelop = spec.base_branch === "develop";
    const isPendingDeploy = spec.release_status === "pending_deploy" && spec.release_pr_status === "merged";

    if (isReleasePr || isPendingDeploy) {
      // This is a release PR (develop → main) - deploy to production
      if (["deploying", "deployed"].includes(spec.release_status ?? "not_started")) {
        return NextResponse.json(
          {
            error: "Production deployment is already in progress or completed for this release PR.",
            detail: "Use the existing release tag/deployment record instead of approving another workflow run."
          },
          { status: 409 }
        );
      }

      releasePrMode = "merge_existing_pr";
      try {
        await ensureReleaseTagAvailable({
          owner,
          repo,
          sha: spec.merge_sha ?? ciRun.head_sha ?? "",
          releaseTag,
          token: userGitHubToken
        });
        // Check if PR is already merged (pending_deploy state)
        if (isPendingDeploy && spec.merge_sha) {
          // PR already merged on GitHub - just tag and deploy
          release = await tagCommitForRelease({
            owner,
            repo,
            sha: spec.merge_sha,
            releaseTag,
            token: userGitHubToken
          });
        } else {
          // PR not merged yet - merge it first
          releaseMerge = await mergePullRequest({
            owner,
            repo,
            pullNumber: spec.pr_number,
            commitTitle: `release: ${releaseTag}`,
            token: userGitHubToken
          });
          release = await tagCommitForRelease({
            owner,
            repo,
            sha: releaseMerge.destinationSha || releaseMerge.sha,
            releaseTag,
            token: userGitHubToken
          });
        }

        deployment = await dispatchVercelProductionDeploy({
          owner,
          repo,
          releaseTag: release.releaseTag,
          releaseSha: release.sha,
          token: userGitHubToken
        });
      } catch (error) {
        return NextResponse.json(
          {
            error: "ShipBrain could not complete the production release.",
            detail: error instanceof Error ? error.message : "Release PR merge, tagging, or Vercel dispatch failed."
          },
          { status: 409 }
        );
      }
    } else if (isFeaturePrToDevelop) {
      // Feature PR merged to develop: validate/audit and actively dispatch a Vercel Preview deploy.
      // No release tag is created here. Production remains the develop->main release PR path.
      releasePrMode = null;
      try {
        const { data: repoRow } = await db
          .from("repos")
          .select("default_branch")
          .eq("full_name", ciRun.repo_full_name)
          .single();

        const defaultBranch = repoRow?.default_branch || "main";

        previewDeployment = await dispatchDevelopPreviewDeploy({
          owner,
          repo,
          ref: "develop",
          defaultBranch,
          sourcePrNumber: spec.pr_number,
          token: userGitHubToken
        });
      } catch (error) {
        return NextResponse.json(
          {
            error: "ShipBrain could not start the develop preview deployment.",
            detail: error instanceof Error ? error.message : "GitHub workflow_dispatch for ShipBrain CI failed."
          },
          { status: 409 }
        );
      }
    } else if (spec.status !== "merged" || !spec.merge_sha) {
      return NextResponse.json(
        { error: "Approval requires the PR to be merged first.", detail: "Merge the PR, wait for the green CI run, then approve." },
        { status: 409 }
      );
    }
  }

  // Determine the deployment state based on what action was taken
  const isAuditOnly = releasePrMode === null && action === "deploy_approved";
  const deploymentState = action !== "deploy_approved"
    ? "not_started"
    : releasePrMode === "merge_existing_pr"
      ? "dispatch_started"
      : isAuditOnly
        ? "develop_validated"
        : "release_pr_open";

  const metadata = {
    simulation: false,
    repo: ciRun.repo_full_name,
    branch: ciRun.branch,
    promotedFromBranch: spec?.base_branch ?? "develop",
    specId: ciRun.spec_id,
    prNumber: ciRun.pr_number,
    workflowName: ciRun.workflow_name,
    title: ciRun.title,
    htmlUrl: ciRun.html_url,
    headSha: ciRun.head_sha,
    conclusion: ciRun.conclusion,
    releaseTag: isAuditOnly ? null : releaseTag,
    sourcePrNumber: ciRun.pr_number,
    sourceMergeSha: releaseMerge?.destinationSha ?? spec?.merge_sha,
    releasePrMode,
    releasePrNumber: releasePrMode === "merge_existing_pr" ? spec?.pr_number : undefined,
    releasePrUrl: releasePrMode === "merge_existing_pr" ? spec?.pr_url : undefined,
    releasePrBase: releasePrMode === "merge_existing_pr" ? spec?.base_branch : undefined,
    releasePrHead: releasePrMode === "merge_existing_pr" ? spec?.branch_name : undefined,
    releaseUrl: release?.releaseUrl,
    releaseSha: release?.sha,
    deploymentWorkflowUrl: deployment?.workflowUrl,
    previewWorkflowUrl: previewDeployment?.workflowUrl,
    previewRef: previewDeployment?.ref,
    previewUrl: spec?.preview_url ?? null,
    previewStatus: spec?.preview_status ?? null,
    previewBranchAlias: spec?.preview_branch_alias ?? null,
    deploymentState,
    auditOnly: isAuditOnly,
    approvedFor: isAuditOnly ? "develop preview deployment" : "production release deployment"
  };

  const { data, error } = await db
    .from("approval_events")
    .insert({
      entity_type: "ci_run",
      entity_id: runId,
      action,
      actor_id: user.id,
      note: note || null,
      metadata
    })
    .select("id, action, note, metadata, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: "Unable to record deployment audit.", detail: error.message }, { status: 500 });
  }

  // Synchronize with release trace
  if (ciRun.spec_id) {
    try {
      const { updateTraceBySpec } = await import("@/lib/orchestrator");
      let tracePatch: any = {};
      let traceEventType: any = "manual_action";
      let traceEventDetails: any = { note: note || undefined };

      if (action !== "deploy_approved") {
        tracePatch = { status: "failed" };
        traceEventType = "manual_action";
        traceEventDetails = { note: note || "Deployment rejected" };
      } else if (releasePrMode === "merge_existing_pr") {
        tracePatch = {
          status: "merged_main",
          production_deployment: {
            status: "deploying",
            url: deployment?.workflowUrl ?? release?.releaseUrl ?? null,
            releaseTag,
            releaseSha: release?.sha ?? releaseMerge?.destinationSha ?? releaseMerge?.sha ?? null,
            timestamp: new Date().toISOString()
          }
        };
        traceEventType = "deployment_started";
        traceEventDetails = { note: note || "Production deployment approved", releaseTag };
      } else if (isAuditOnly) {
        tracePatch = {
          status: "preview_live",
          preview_deployment: {
            status: "deploying",
            url: previewDeployment?.workflowUrl ?? null,
            timestamp: new Date().toISOString()
          }
        };
        traceEventType = "pr_approved";
        traceEventDetails = { note: note || "Develop preview deployment approved" };
      }

      await updateTraceBySpec(ciRun.spec_id, tracePatch, {
        eventType: traceEventType,
        source: "manual",
        actor: profile?.github_login ?? user.email ?? "User",
        actorType: "user",
        details: traceEventDetails
      });
    } catch (traceErr) {
      console.error("Failed to sync trace event:", traceErr);
    }
  }

  if (ciRun.spec_id) {
    let specUpdate: Record<string, unknown>;

    if (action !== "deploy_approved") {
      // Rejected
      specUpdate = {
        deployment_status: "rejected",
        deployment_approved_at: null,
        deployment_audit_id: data.id,
        release_tag: null,
        release_sha: null,
        release_status: "rejected",
        release_pr_number: null,
        release_pr_url: null,
        release_pr_status: "rejected",
        merged_at: null,
        deployed_at: null,
        deployment_url: null,
        updated_at: new Date().toISOString()
      };
    } else if (releasePrMode === "merge_existing_pr") {
      // Release PR merged - deploying to production
      specUpdate = {
        deployment_status: "approved",
        deployment_approved_at: data.created_at,
        deployment_audit_id: data.id,
        release_tag: releaseTag,
        release_sha: release?.sha ?? releaseMerge?.destinationSha ?? releaseMerge?.sha ?? null,
        release_status: "deploying",
        release_pr_number: spec?.pr_number ?? null,
        release_pr_url: spec?.pr_url ?? null,
        release_pr_status: "merged",
        deployed_at: null,
        deployment_url: deployment?.workflowUrl ?? release?.releaseUrl ?? null,
        status: "merged",
        merge_sha: releaseMerge?.destinationSha ?? releaseMerge?.sha ?? spec?.merge_sha ?? null,
        feature_head_sha: releaseMerge?.destinationSha ?? releaseMerge?.sha ?? spec?.merge_sha ?? null,
        ...(spec?.merge_sha ? {} : { merged_at: new Date().toISOString() }),
        updated_at: new Date().toISOString()
      };
    } else if (isAuditOnly) {
      // Feature PR to develop - audit only, mark as validated
      specUpdate = {
        deployment_status: "develop_validated",
        deployment_approved_at: data.created_at,
        deployment_audit_id: data.id,
        release_status: "ready_for_prod",
        preview_status: "deploying",
        updated_at: new Date().toISOString()
      };
    } else {
      // Fallback - should not reach here in normal flow
      specUpdate = {
        deployment_status: "approved",
        deployment_approved_at: data.created_at,
        deployment_audit_id: data.id,
        updated_at: new Date().toISOString()
      };
    }

    await db
      .from("specs")
      .update(specUpdate)
      .eq("id", ciRun.spec_id);

    // Create notification for deployment approval/rejection
    const notificationType = action === "deploy_approved"
      ? releasePrMode === "merge_existing_pr" ? "production_deploy_approved" : "preview_deploy_approved"
      : "deploy_rejected";
    const notificationTitle = action === "deploy_approved"
      ? releasePrMode === "merge_existing_pr" ? "Production Deployment Approved" : "Preview Deployment Approved"
      : "Deployment Rejected";
    const notificationBody = action === "deploy_approved"
      ? releasePrMode === "merge_existing_pr"
        ? `Approved production deployment for ${releaseTag}`
        : `Approved preview deployment for PR #${ciRun.pr_number}`
      : `Rejected deployment for PR #${ciRun.pr_number}`;

    await db
      .from("notifications")
      .insert({
        user_id: user.id,
        type: notificationType,
        title: notificationTitle,
        body: notificationBody,
        href: deployment?.workflowUrl ?? previewDeployment?.workflowUrl ?? ciRun.html_url,
        severity: action === "deploy_approved" ? "info" : "warning",
        repo_full_name: ciRun.repo_full_name,
        metadata: { specId: ciRun.spec_id, prNumber: ciRun.pr_number, releaseTag: isAuditOnly ? null : releaseTag }
      })
      .then(({ error: notifError }) => {
        if (notifError) console.error("notification creation failed:", notifError);
      });
  }

  return NextResponse.json(toAudit(data));
}
