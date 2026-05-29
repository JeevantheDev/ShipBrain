import { NextResponse } from "next/server";
import { dispatchDevelopPreviewDeploy, dispatchHotfixDeploy } from "@/lib/github/deployments";
import { listPullRequestCommits } from "@/lib/github/commits";
import { createDraftPR, createReverseSyncPR, mergePullRequest, tagCommitForRelease } from "@/lib/github/pr";
import { createOrUpdateTrace, updateTraceByIncident } from "@/lib/orchestrator";
import { resolvePagerDutyIncident } from "@/lib/pagerduty/incidents";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function hotfixReleaseTag(incidentId: string) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
  return `hotfix-v${date}-${incidentId.slice(0, 8)}`;
}

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

function renderHotfixHandoff(input: { incident: any; analysis: any; releaseContext: any }) {
  const commits = [
    ...(input.releaseContext?.commits?.featurePr ?? []),
    ...(input.releaseContext?.commits?.releasePr ?? [])
  ];

  return [
    `# ShipBrain Incident Hotfix`,
    ``,
    `Incident: ${input.incident.title ?? input.incident.id}`,
    `Source release: ${input.incident.release_version ?? input.releaseContext?.release?.tag ?? "not captured"}`,
    `Repository: ${input.incident.repo_full_name}`,
    ``,
    `## AI analysis`,
    ``,
    `Root cause: ${input.analysis?.rootCause ?? "Pending developer verification."}`,
    ``,
    `Fix proposal: ${input.analysis?.fixProposal ?? "Pending developer implementation."}`,
    ``,
    `How it occurred: ${input.analysis?.changeSummary ?? "ShipBrain did not receive enough commit context to infer a precise path."}`,
    ``,
    `## Related release commits`,
    commits.length
      ? commits.map((commit: any) => `- ${commit.shortSha ?? commit.sha?.slice(0, 7)} ${commit.message}`).join("\n")
      : `- No linked release commits were found.`,
    ``,
    `## Developer instructions`,
    ``,
    `1. Implement the fix on this hotfix branch.`,
    `2. Keep commits focused and descriptive; ShipBrain will re-read this PR before manager approval.`,
    `3. When the PR is reviewed, approve the incident fix in ShipBrain to merge this PR and trigger CI.`,
    ``,
    `ShipBrain-codegen: incident-hotfix-handoff-only`
  ].join("\n");
}

async function getUserOr401() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function POST(request: Request) {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const incidentId = String(body.incidentId ?? "");
  const action = String(body.action ?? "create");
  if (!incidentId) return NextResponse.json({ error: "incidentId is required" }, { status: 400 });

  const { data: incident, error: incidentError } = await supabase
    .from("incidents")
    .select("*")
    .eq("id", incidentId)
    .eq("user_id", user.id)
    .single();

  if (incidentError) return NextResponse.json({ error: "Unable to load incident.", detail: incidentError.message }, { status: 500 });
  if (!incident.repo_full_name?.includes("/")) {
    return NextResponse.json({ error: "Incident is not linked to a connected GitHub repository." }, { status: 400 });
  }

  const { owner, repo } = splitRepo(incident.repo_full_name);

  if (action === "create") {
    if (incident.hotfix_pr_number) {
      return NextResponse.json({
        incident: toIncident(incident),
        pr: {
          number: incident.hotfix_pr_number,
          html_url: incident.hotfix_pr_url,
          branch: incident.hotfix_branch,
          base: incident.hotfix_base_branch
        }
      });
    }

    const titleSlug = slugify(incident.title ?? "incident-fix");
    const branch = `hotfix/incident-${incident.id.slice(0, 8)}-${titleSlug || "fix"}`;
    const base = String(body.baseBranch ?? "develop").trim() || "develop";
    const analysis = body.analysis ?? {};
    const releaseContext = body.releaseContext ?? analysis.releaseContext ?? null;
    const handoff = renderHotfixHandoff({ incident, analysis, releaseContext });
    const prTitle = `hotfix: ${incident.title ?? "incident fix"}`;
    const prBody = [
      `## ShipBrain incident hotfix`,
      ``,
      `Incident: \`${incident.id}\``,
      `Release: \`${incident.release_version ?? releaseContext?.release?.tag ?? "not captured"}\``,
      ``,
      `### AI root cause`,
      analysis.rootCause ?? "Pending analysis.",
      ``,
      `### Fix direction`,
      analysis.fixProposal ?? "Pending developer implementation.",
      ``,
      `### Manager approval expectation`,
      `After the developer pushes the fix commits, ShipBrain will show the PR commit list in Incident Commander before approval. Approval merges this PR into \`${base}\` and lets CI run from GitHub.`
    ].join("\n");

    const pr = await createDraftPR({
      owner,
      repo,
      base,
      branch,
      title: prTitle,
      body: prBody,
      files: {
        "SHIPBRAIN_INCIDENT_HOTFIX.md": handoff
      }
    });

    const { data: spec, error: specError } = await supabase
      .from("specs")
      .insert({
        user_id: user.id,
        raw_spec: handoff,
        repo_full_name: incident.repo_full_name,
        branch_name: branch,
        base_branch: base,
        pr_number: pr.number,
        pr_url: pr.html_url,
        status: "draft_created",
        incident_id: incident.id,
        updated_at: new Date().toISOString()
      })
      .select("id")
      .single();

    if (specError) return NextResponse.json({ error: "Hotfix PR was created, but ShipBrain could not save its tracker.", detail: specError.message }, { status: 500 });

    const commits = await listPullRequestCommits({ owner, repo, pullNumber: pr.number }).catch(() => []);
    const { data, error } = await supabase
      .from("incidents")
      .update({
        status: "investigating",
        root_cause: analysis.rootCause ?? incident.root_cause,
        ai_fix_proposal: analysis.fixProposal ?? incident.ai_fix_proposal,
        ai_analysis: analysis,
        hotfix_branch: branch,
        hotfix_base_branch: base,
        hotfix_pr_number: pr.number,
        hotfix_pr_url: pr.html_url,
        hotfix_pr_status: "draft_created",
        hotfix_commits: commits,
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: "Hotfix PR was created, but incident sync failed.", detail: error.message }, { status: 500 });

    // Create notification for hotfix PR created
    await supabase
      .from("notifications")
      .insert({
        user_id: user.id,
        type: "hotfix_created",
        title: "Hotfix PR Created",
        body: `Created hotfix PR #${pr.number} for incident: ${incident.title ?? incident.id.slice(0, 8)}`,
        href: pr.html_url,
        severity: "warning",
        repo_full_name: incident.repo_full_name,
        metadata: { incidentId: incident.id, prNumber: pr.number, branch }
      })
      .catch((err) => console.error("notification creation failed", err));

    return NextResponse.json({ incident: toIncident(data), specId: spec.id, pr: { ...pr, branch, base }, commits });
  }

  if (action === "sync") {
    if (!incident.hotfix_pr_number) {
      return NextResponse.json({ error: "No hotfix PR is linked to this incident yet." }, { status: 400 });
    }

    const commits = await listPullRequestCommits({ owner, repo, pullNumber: incident.hotfix_pr_number });
    const { data, error } = await supabase
      .from("incidents")
      .update({
        hotfix_commits: commits,
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: "Unable to refresh hotfix commits.", detail: error.message }, { status: 500 });
    return NextResponse.json({ incident: toIncident(data), commits });
  }

  if (action === "approve") {
    if (!incident.hotfix_pr_number) {
      return NextResponse.json({ error: "Create the incident hotfix Draft PR before approving the fix." }, { status: 400 });
    }

    const commits = await listPullRequestCommits({ owner, repo, pullNumber: incident.hotfix_pr_number });
    const merge = await mergePullRequest({
      owner,
      repo,
      pullNumber: incident.hotfix_pr_number,
      commitTitle: `hotfix: resolve ${incident.title ?? incident.id}`
    });
    const isProdDeploy = merge.baseBranch === "main";
    const releaseTag = hotfixReleaseTag(incident.id);
    let deployment: any = null;
    let deploymentError: string | null = null;

    try {
      if (isProdDeploy) {
        const release = await tagCommitForRelease({
          owner,
          repo,
          sha: merge.sha,
          releaseTag
        });
        deployment = await dispatchHotfixDeploy({
          owner,
          repo,
          releaseTag: release.releaseTag,
          releaseSha: release.sha,
          reverseSync: true
        });
      } else {
        const { data: repoRow } = await supabase
          .from("repos")
          .select("default_branch")
          .eq("full_name", incident.repo_full_name)
          .single();
        const defaultBranch = repoRow?.default_branch || "main";

        deployment = await dispatchDevelopPreviewDeploy({
          owner,
          repo,
          ref: merge.baseBranch,
          defaultBranch,
          sourcePrNumber: incident.hotfix_pr_number
        });
      }
    } catch (error) {
      deploymentError = error instanceof Error ? error.message : "Hotfix deployment dispatch failed.";
    }

    let pagerDutySyncStatus: string | null = incident.pagerduty_sync_status ?? null;
    let pagerDutySyncError: string | null = incident.pagerduty_sync_error ?? null;

    if (incident.alert_source === "pagerduty" && incident.external_id) {
      const pagerDutyResult = await resolvePagerDutyIncident({
        incidentId: incident.external_id,
        fromEmail: process.env.PAGERDUTY_FROM_EMAIL ?? user.email,
        note: [
          "ShipBrain approved and merged the incident hotfix.",
          `Hotfix PR: ${incident.hotfix_pr_url}`,
          `Merge SHA: ${merge.sha}`,
          incident.root_cause ? `Root cause: ${incident.root_cause}` : "",
          incident.ai_fix_proposal ? `Fix proposal: ${incident.ai_fix_proposal}` : ""
        ].filter(Boolean).join("\n\n")
      });
      if (!pagerDutyResult.ok) {
        pagerDutySyncStatus = "action_required";
        pagerDutySyncError = pagerDutyResult.detail ?? "The configured alert provider rejected the incident update. Check ShipBrain alert provider settings.";
      } else {
        pagerDutySyncStatus = pagerDutyResult.skipped ? "skipped" : "resolved";
        pagerDutySyncError = pagerDutyResult.detail ?? null;
      }
    }

    // Create reverse sync PR if hotfix was merged to main (production)
    // This keeps develop in sync with production hotfixes
    let reverseSyncPr: Awaited<ReturnType<typeof createReverseSyncPR>> | null = null;
    let reverseSyncError: string | null = null;
    const needsReverseSync = merge.baseBranch === "main";

    if (needsReverseSync) {
      try {
        reverseSyncPr = await createReverseSyncPR({
          owner,
          repo,
          sourceBranch: "main",
          targetBranch: "develop",
          incidentId: incident.id,
          incidentTitle: incident.title ?? "Incident fix",
          hotfixPrNumber: incident.hotfix_pr_number,
          releaseTag
        });
      } catch (error) {
        reverseSyncError = error instanceof Error ? error.message : "Failed to create reverse sync PR";
      }
    }

    // Record incident fix audit event
    await supabase.from("approval_events").insert({
      entity_type: "incident",
      entity_id: incident.id,
      action: "fix_approved",
      actor_id: user.id,
      note: body.note ?? null,
      metadata: {
        incidentTitle: incident.title,
        hotfixPrNumber: incident.hotfix_pr_number,
        hotfixPrUrl: incident.hotfix_pr_url,
        hotfixBranch: merge.headBranch,
        hotfixBaseBranch: merge.baseBranch,
        mergeSha: merge.sha,
        releaseTag: isProdDeploy ? releaseTag : null,
        pagerDutySyncStatus,
        reverseSyncPrNumber: reverseSyncPr?.number ?? null,
        reverseSyncPrUrl: reverseSyncPr?.html_url ?? null,
        reverseSyncCreated: reverseSyncPr?.created ?? false,
        deploymentDispatched: Boolean(deployment)
      }
    });

    const { data, error } = await supabase
      .from("incidents")
      .update({
        status: "resolved",
        hotfix_pr_status: "merged",
        hotfix_branch: merge.headBranch,
        hotfix_base_branch: merge.baseBranch,
        hotfix_merge_sha: merge.sha,
        hotfix_commits: commits,
        release_version: isProdDeploy ? releaseTag : null,
        fix_approved_at: new Date().toISOString(),
        pagerduty_sync_status: pagerDutySyncStatus,
        pagerduty_sync_error: pagerDutySyncError,
        reverse_sync_pr_number: reverseSyncPr?.number ?? null,
        reverse_sync_pr_url: reverseSyncPr?.html_url ?? null,
        reverse_sync_pr_status: reverseSyncPr ? "open" : null,
        reverse_sync_branch: needsReverseSync ? "develop" : null,
        reverse_sync_created_at: reverseSyncPr ? new Date().toISOString() : null,
        reverse_sync_error: reverseSyncError,
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: "Hotfix merged, but incident update failed.", detail: error.message }, { status: 500 });

    const specUpdate: Record<string, any> = {
      status: "merged",
      branch_name: merge.headBranch,
      base_branch: merge.baseBranch,
      merge_sha: merge.sha,
      feature_head_sha: merge.destinationSha,
      deployment_url: deployment?.workflowUrl ?? null,
      error_message: deploymentError,
      merged_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (isProdDeploy) {
      specUpdate.deployment_status = deployment ? "approved" : "not_requested";
      specUpdate.release_tag = releaseTag;
      specUpdate.release_sha = deployment ? merge.sha : null;
      specUpdate.release_status = deployment ? "deploying" : "failed";
    } else {
      specUpdate.deployment_status = deployment ? "develop_validated" : "not_requested";
      specUpdate.preview_status = deployment ? "deploying" : "failed";
    }

    await supabase
      .from("specs")
      .update(specUpdate)
      .eq("incident_id", incident.id);

    try {
      await createOrUpdateTrace({
        userId: user.id,
        repoFullName: incident.repo_full_name,
        type: "hotfix",
        title: incident.title ?? `Incident ${incident.id.slice(0, 8)} hotfix`,
        description: incident.root_cause ?? incident.raw_logs ?? null,
        status: isProdDeploy ? "merged_main" : "merged_develop",
        sourceBranch: merge.headBranch,
        targetBranch: merge.baseBranch,
        draftPrNumber: incident.hotfix_pr_number,
        draftPrUrl: incident.hotfix_pr_url,
        incidentId: incident.id,
        source: "system",
        actor: user.email ?? "manager",
        eventType: "pr_merged",
        details: {
          hotfixPrNumber: incident.hotfix_pr_number,
          releaseTag: isProdDeploy ? releaseTag : null,
          deploymentDispatched: Boolean(deployment),
          deploymentWorkflowUrl: deployment?.workflowUrl ?? null
        }
      });

      if (isProdDeploy) {
        await updateTraceByIncident(incident.id, {
          status: deployment ? "merged_main" : "failed",
          production_deployment: {
            status: deployment ? "deploying" : "failed",
            tag: releaseTag,
            sha: merge.sha,
            workflowUrl: deployment?.workflowUrl ?? null,
            error: deploymentError
          },
          reverse_sync_pr_number: reverseSyncPr?.number ?? null,
          reverse_sync_pr_url: reverseSyncPr?.html_url ?? null,
          reverse_sync_status: reverseSyncPr ? "open" : reverseSyncError ? "failed" : null
        }, {
          eventType: reverseSyncPr ? "reverse_sync_created" : "deployment_started",
          source: "system",
          actor: "ShipBrain",
          details: {
            releaseTag,
            deploymentWorkflowUrl: deployment?.workflowUrl ?? null,
            reverseSyncPrNumber: reverseSyncPr?.number ?? null,
            reverseSyncPrUrl: reverseSyncPr?.html_url ?? null,
            reverseSyncError
          }
        });
      }
    } catch (traceError) {
      console.error("hotfix release trace update failed", traceError);
    }

    // Create notification for hotfix approved
    await supabase
      .from("notifications")
      .insert({
        user_id: user.id,
        type: "hotfix_approved",
        title: "Hotfix Approved & Merged",
        body: `Hotfix for incident "${incident.title ?? incident.id.slice(0, 8)}" merged${isProdDeploy ? ` and deploying to production` : ""}`,
        href: deployment?.workflowUrl ?? incident.hotfix_pr_url,
        severity: isProdDeploy ? "warning" : "info",
        repo_full_name: incident.repo_full_name,
        metadata: { incidentId: incident.id, mergeSha: merge.sha, releaseTag: isProdDeploy ? releaseTag : null }
      })
      .catch((err) => console.error("notification creation failed", err));

    return NextResponse.json({
      incident: toIncident(data),
      merge,
      commits,
      deployment,
      deploymentError: merge.mergedIntoDestination ? deploymentError : deploymentError ?? `GitHub merged the PR, but ${merge.baseBranch} is at ${merge.destinationSha} instead of ${merge.sha}.`,
      releaseTag: isProdDeploy ? releaseTag : null,
      reverseSync: reverseSyncPr ? {
        prNumber: reverseSyncPr.number,
        prUrl: reverseSyncPr.html_url,
        created: reverseSyncPr.created,
        targetBranch: "develop"
      } : null,
      reverseSyncError
    });
  }

  return NextResponse.json({ error: "Unsupported hotfix action." }, { status: 400 });
}
