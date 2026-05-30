import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isBranchDeleteEvent, statusFromPullRequestEvent, verifyWebhookSignature } from "@/lib/github/webhooks";
import { createOrUpdateTrace, updateTraceBySpecOrPr, associateFeaturesWithRelease, dissociateFeaturesFromRelease } from "@/lib/orchestrator";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

export async function POST(request: Request) {
  const payload = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const event = request.headers.get("x-github-event");

  if (process.env.GITHUB_WEBHOOK_SECRET && !verifyWebhookSignature(payload, signature)) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  const json = JSON.parse(payload);
  const supabase = getSupabaseAdminClient();

  if (event === "workflow_run") {
    const workflowRun = json.workflow_run ?? {};
    const repoFullName = json.repository?.full_name ?? null;
    const branch = workflowRun.head_branch ?? null;
    const isVercelDeploy = workflowRun.name === "ShipBrain Production Deploy" || workflowRun.name === "ShipBrain Vercel Production Deploy";
    const isPreviewDeploy = /preview/i.test(String(workflowRun.name ?? ""));
    const displayBranch = isPreviewDeploy ? "develop" : branch;
    const workflowPrNumber = workflowRun.pull_requests?.[0]?.number ?? null;

    // 1. Try to find the spec by checking if there's already an existing CI run in our DB with this run ID
    const { data: existingCiRun } = repoFullName
      ? await supabase
          .from("ci_runs")
          .select("spec_id, pr_number")
          .eq("github_run_id", workflowRun.id)
          .maybeSingle()
      : { data: null };

    const { data: existingCiRunSpec } = (repoFullName && existingCiRun?.spec_id)
      ? await supabase
          .from("specs")
          .select("id, pr_number")
          .eq("id", existingCiRun.spec_id)
          .maybeSingle()
      : { data: null };

    // 2. Try to find spec that has this workflow run as its latest CI run or deployment run
    const { data: matchedRunSpec } = repoFullName
      ? await supabase
          .from("specs")
          .select("id, pr_number")
          .eq("repo_full_name", repoFullName)
          .or(`latest_ci_run_id.eq.${workflowRun.id},deployment_run_id.eq.${workflowRun.id}`)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };

    const { data: pullRequestSpec } = repoFullName && workflowPrNumber
      ? await supabase
          .from("specs")
          .select("id, pr_number")
          .eq("repo_full_name", repoFullName)
          .eq("pr_number", workflowPrNumber)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };
    const { data: branchSpec } = repoFullName && branch
      ? await supabase
          .from("specs")
          .select("id, pr_number")
          .eq("repo_full_name", repoFullName)
          .eq("branch_name", branch)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };
    const { data: releaseSpec } = repoFullName && workflowRun.head_sha
      ? await supabase
          .from("specs")
          .select("id, pr_number")
          .eq("repo_full_name", repoFullName)
          .eq("release_sha", workflowRun.head_sha)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };
    const { data: releaseTagSpec } = repoFullName && branch
      ? await supabase
          .from("specs")
          .select("id, pr_number")
          .eq("repo_full_name", repoFullName)
          .eq("release_tag", branch)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };
    const { data: mergedSpec } = repoFullName && workflowRun.head_sha
      ? await supabase
          .from("specs")
          .select("id, pr_number")
          .eq("repo_full_name", repoFullName)
          .eq("merge_sha", workflowRun.head_sha)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };
    // For production deploy workflows, also try to find a spec that's currently deploying
    const { data: deployingSpec } = isVercelDeploy && repoFullName && !pullRequestSpec && !releaseSpec && !releaseTagSpec && !mergedSpec
      ? await supabase
          .from("specs")
          .select("id, pr_number")
          .eq("repo_full_name", repoFullName)
          .eq("release_status", "deploying")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };

    const spec = existingCiRunSpec ?? matchedRunSpec ?? pullRequestSpec ?? releaseSpec ?? releaseTagSpec ?? mergedSpec ?? deployingSpec ?? branchSpec;

    const { error: ciError } = await supabase
      .from("ci_runs")
      .upsert(
        {
          github_run_id: workflowRun.id,
          spec_id: spec?.id ?? existingCiRun?.spec_id ?? null,
          pr_number: spec?.pr_number ?? existingCiRun?.pr_number ?? null,
          repo_full_name: repoFullName,
          workflow_name: workflowRun.name ?? null,
          title: workflowRun.display_title ?? workflowRun.name ?? `Workflow run #${workflowRun.id}`,
          html_url: workflowRun.html_url ?? null,
          head_sha: workflowRun.head_sha ?? null,
          event: workflowRun.event ?? null,
          branch: displayBranch,
          status: workflowRun.status ?? "queued",
          conclusion: workflowRun.conclusion ?? null,
          environment: isPreviewDeploy ? "preview" : isVercelDeploy ? "production" : null,
          updated_at: new Date().toISOString()
        },
        { onConflict: "github_run_id" }
      );

    if (ciError) {
      return NextResponse.json({ error: "Unable to sync workflow run webhook.", detail: ciError.message }, { status: 500 });
    }

    if (spec?.id) {
      const specUpdate = isVercelDeploy
        ? {
            deployment_run_id: workflowRun.id,
            deployment_url: workflowRun.html_url ?? null,
            release_status:
              workflowRun.status === "completed"
                ? workflowRun.conclusion === "success"
                  ? "deployed"
                  : "failed"
                : "deploying",
            deployed_at: workflowRun.status === "completed" && workflowRun.conclusion === "success" ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
          }
        : {
            ci_status: workflowRun.status ?? "queued",
            ci_conclusion: workflowRun.conclusion ?? null,
            latest_ci_run_id: workflowRun.id,
            feature_head_sha: workflowRun.head_sha ?? null,
            feature_last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

      await supabase.from("specs").update(specUpdate).eq("id", spec.id);

      if (isVercelDeploy || isPreviewDeploy) {
        await updateTraceBySpecOrPr({
          specId: spec.id,
          repoFullName,
          prNumber: spec.pr_number ?? workflowPrNumber,
          branchName: branch,
          patch: {
            status: isVercelDeploy
              ? workflowRun.status === "completed"
                ? workflowRun.conclusion === "success"
                  ? "production_live"
                  : "failed"
                : "merged_main"
              : workflowRun.status === "completed"
                ? workflowRun.conclusion === "success"
                  ? "preview_live"
                  : "failed"
                : "merged_develop",
            ...(isVercelDeploy
              ? { production_deployment: { status: workflowRun.conclusion ?? workflowRun.status, url: workflowRun.html_url, sha: workflowRun.head_sha, timestamp: new Date().toISOString(), runId: workflowRun.id } }
              : { preview_deployment: { status: workflowRun.conclusion ?? workflowRun.status, url: workflowRun.html_url, sha: workflowRun.head_sha, timestamp: new Date().toISOString(), runId: workflowRun.id } })
          },
          event: {
            eventType: workflowRun.status === "completed"
              ? workflowRun.conclusion === "success"
                ? "deployment_succeeded"
                : "deployment_failed"
              : "deployment_started",
            source: "github",
            actor: workflowRun.actor?.login ?? "github-actions",
            actorType: "github",
            details: {
              workflowRunId: workflowRun.id,
              workflowName: workflowRun.name,
              runUrl: workflowRun.html_url,
              conclusion: workflowRun.conclusion,
              status: workflowRun.status
            }
          }
        });
      }
    }

    return NextResponse.json({
      type: "ci_run",
      github_run_id: workflowRun.id,
      spec_id: spec?.id ?? null,
      pr_number: spec?.pr_number ?? null,
      repo: repoFullName,
      title: workflowRun.display_title ?? workflowRun.name,
      branch: workflowRun.head_branch,
      status: workflowRun.status,
      conclusion: workflowRun.conclusion
    });
  }

  if (event === "pull_request") {
    const pullRequest = json.pull_request ?? {};
    const repoFullName = json.repository?.full_name;
    const nextStatus = statusFromPullRequestEvent(json);
    let updated = 0;
    let syncedSpecId: string | null = null;

    if (repoFullName && pullRequest.number && nextStatus) {
      // When a release PR (develop→main) is merged on GitHub, DO NOT auto-deploy
      // Just mark it as pending deployment - deployment only happens from CI Monitor
      const { data: releaseSpec } = nextStatus === "merged"
        ? await supabase
            .from("specs")
            .select("id, release_tag, release_sha, release_status")
            .eq("repo_full_name", repoFullName)
            .eq("release_pr_number", pullRequest.number)
            .maybeSingle()
        : { data: null };

      if (releaseSpec?.id && nextStatus === "merged") {
        // Mark as pending deployment - actual deploy happens from CI Monitor
        await supabase
          .from("specs")
          .update({
            release_pr_status: "merged",
            release_status: "pending_deploy",
            merge_sha: pullRequest.merge_commit_sha ?? null,
            updated_at: new Date().toISOString()
          })
          .eq("id", releaseSpec.id);
      }

      const isReleasePromotionPr =
        pullRequest.head?.ref === "develop" &&
        pullRequest.base?.ref === "main";

      if (isReleasePromotionPr) {
        if (nextStatus === "closed") {
          await dissociateFeaturesFromRelease(repoFullName, pullRequest.number).catch((err) => console.error("Error dissociating features:", err));
        } else {
          await associateFeaturesWithRelease(
            repoFullName,
            pullRequest.number,
            pullRequest.html_url,
            nextStatus === "merged" ? "merged" : (pullRequest.state || "open")
          ).catch((err) => console.error("Error associating features:", err));
        }
      }

      // For release PRs (develop → main), find the latest ready_for_prod spec and update it
      if (isReleasePromotionPr && nextStatus === "merged") {
        const { data: readySpec } = await supabase
          .from("specs")
          .select("id")
          .eq("repo_full_name", repoFullName)
          .eq("base_branch", "develop")
          .eq("status", "merged")
          .eq("release_status", "ready_for_prod")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (readySpec?.id) {
          syncedSpecId = readySpec.id;
          await supabase
            .from("specs")
            .update({
              release_pr_number: pullRequest.number,
              release_pr_url: pullRequest.html_url,
              release_pr_status: "merged",
              release_status: "pending_deploy",
              release_sha: pullRequest.merge_commit_sha ?? null,
              updated_at: new Date().toISOString()
            })
            .eq("id", readySpec.id);
        }
      }

      if (isReleasePromotionPr && (nextStatus === "merged" || nextStatus === "closed")) {
        await supabase
          .from("specs")
          .update({
            status: nextStatus,
            ...(nextStatus === "merged" ? { merged_at: pullRequest.merged_at ?? new Date().toISOString() } : {}),
            updated_at: new Date().toISOString()
          })
          .eq("repo_full_name", repoFullName)
          .eq("pr_number", pullRequest.number);
      }

      const prUpdate =
        nextStatus === "merged"
          ? isReleasePromotionPr
            ? null // Already handled above
            : {
              status: nextStatus,
              pr_number: pullRequest.number,
              pr_url: pullRequest.html_url,
              branch_name: pullRequest.head?.ref,
              base_branch: pullRequest.base?.ref,
              merged_at: pullRequest.merged_at ?? new Date().toISOString(),
              merge_sha: pullRequest.merge_commit_sha ?? null,
              feature_head_sha: pullRequest.head?.sha ?? null,
              feature_last_synced_at: new Date().toISOString(),
              release_status: pullRequest.base?.ref === "main" ? "pending_deploy" : "ready_for_prod",
              ...(pullRequest.base?.ref === "main" ? { release_pr_status: "merged" } : {}),
              updated_at: new Date().toISOString()
            }
          : {
              status: nextStatus,
              pr_number: pullRequest.number,
              pr_url: pullRequest.html_url,
              branch_name: pullRequest.head?.ref,
              base_branch: pullRequest.base?.ref,
              feature_head_sha: pullRequest.head?.sha ?? null,
              feature_last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };

      // Skip standard update for release promotion PRs (already handled above)
      if (prUpdate) {
        // First try to update existing spec
        const { data, error } = await supabase
          .from("specs")
          .update(prUpdate)
          .eq("repo_full_name", repoFullName)
          .eq("pr_number", pullRequest.number)
          .select("id");

        if (error) {
          return NextResponse.json({ error: "Unable to sync pull request webhook.", detail: error.message }, { status: 500 });
        }
        updated = data?.length ?? 0;
        syncedSpecId = data?.[0]?.id ?? null;

        // If no existing spec was updated, create one for this PR
        // This handles PRs created outside ShipBrain or when spec save failed
        if (updated === 0 && (nextStatus === "merged" || isReleasePromotionPr)) {
          // Find the user who owns this repo
          const { data: repoOwner } = await supabase
            .from("repos")
            .select("user_id")
            .eq("full_name", repoFullName)
            .maybeSingle();

          if (repoOwner?.user_id) {
            const { data: newSpec, error: insertError } = await supabase
              .from("specs")
              .insert({
                user_id: repoOwner.user_id,
                raw_spec: pullRequest.body ?? pullRequest.title ?? "",
                decomposed_tasks: { prTitle: pullRequest.title },
                status: nextStatus,
                repo_full_name: repoFullName,
                branch_name: pullRequest.head?.ref,
                base_branch: pullRequest.base?.ref,
                pr_number: pullRequest.number,
                pr_url: pullRequest.html_url,
                merged_at: nextStatus === "merged" ? (pullRequest.merged_at ?? new Date().toISOString()) : null,
                merge_sha: pullRequest.merge_commit_sha ?? null,
                feature_head_sha: pullRequest.head?.sha ?? null,
                release_status: pullRequest.base?.ref === "main" ? (nextStatus === "merged" ? "pending_deploy" : "ready_for_prod") : "ready_for_prod",
                updated_at: new Date().toISOString()
              })
              .select("id")
              .single();

            if (!insertError && newSpec) {
              updated = 1;
              syncedSpecId = newSpec.id;
              console.log(`Created new spec ${newSpec.id} for merged PR #${pullRequest.number}`);

              // Create notification for the user
              const { error: notifError } = await supabase
                .from("notifications")
                .insert({
                  user_id: repoOwner.user_id,
                  type: "pr_merged",
                  title: "PR Merged",
                  body: `PR #${pullRequest.number}: ${pullRequest.title} merged to ${pullRequest.base?.ref}`,
                  href: pullRequest.html_url,
                  severity: "info",
                  repo_full_name: repoFullName,
                  metadata: { prNumber: pullRequest.number, branch: pullRequest.head?.ref, baseBranch: pullRequest.base?.ref }
                });
              if (notifError) console.error("notification creation failed:", notifError);
            }
          }
        }
      } else {
        updated = 1; // Release promotion PR was handled above
      }

      try {
        const baseBranch = pullRequest.base?.ref ?? "develop";
        const headBranch = pullRequest.head?.ref ?? "feature";
        const isHotfix = headBranch.startsWith("hotfix/");
        const isShipBrainSetupPr = headBranch.startsWith("shipbrain/setup");
        const traceStatus =
          nextStatus === "merged"
            ? baseBranch === "main"
              ? "merged_main"
              : "merged_develop"
            : nextStatus === "closed"
              ? "cancelled"
            : pullRequest.draft
              ? "draft"
              : "ready_for_review";

        if (isShipBrainSetupPr) {
          // Onboarding/setup PRs configure ShipBrain itself; they are not product release traces.
        } else if (isReleasePromotionPr && syncedSpecId) {
          const traceUpdated = await updateTraceBySpecOrPr({
            specId: syncedSpecId,
            repoFullName,
            prNumber: pullRequest.number,
            branchName: headBranch,
            patch: {
              status: traceStatus,
              release_pr_number: pullRequest.number,
              release_pr_url: pullRequest.html_url,
              merged_to_main: nextStatus === "merged"
                ? {
                    sha: pullRequest.merge_commit_sha ?? null,
                    mergedAt: pullRequest.merged_at ?? new Date().toISOString(),
                    prNumber: pullRequest.number
                  }
                : null
            },
            event: {
              eventType: nextStatus === "merged" ? "pr_merged" : nextStatus === "closed" ? "status_changed" : json.action === "opened" ? "pr_opened" : "pr_updated",
              source: "github",
              actor: pullRequest.user?.login ?? "github",
              actorType: "github",
              details: {
                action: json.action,
                merged: pullRequest.merged ?? false,
                mergeCommitSha: pullRequest.merge_commit_sha ?? null,
                prNumber: pullRequest.number
              }
            }
          });

          if (!traceUpdated) {
            await createOrUpdateTrace({
              repoFullName,
              type: "release",
              title: pullRequest.title ?? `Release PR #${pullRequest.number}`,
              description: pullRequest.body ?? null,
              status: traceStatus,
              sourceBranch: headBranch,
              targetBranch: baseBranch,
              releasePrNumber: pullRequest.number,
              releasePrUrl: pullRequest.html_url,
              specId: syncedSpecId,
              source: "github",
              actor: pullRequest.user?.login ?? "github",
              eventType: "trace_created",
              details: {
                action: json.action,
                merged: pullRequest.merged ?? false,
                prNumber: pullRequest.number
              }
            }).catch((err) => console.error("Error creating release trace:", err));
          }
        } else {
          await createOrUpdateTrace({
            repoFullName,
            type: isHotfix ? "hotfix" : "feature",
            title: pullRequest.title ?? `PR #${pullRequest.number}`,
            description: pullRequest.body ?? null,
            status: traceStatus,
            sourceBranch: headBranch,
            targetBranch: baseBranch,
            draftPrNumber: pullRequest.number,
            draftPrUrl: pullRequest.html_url,
            specId: syncedSpecId,
            source: "github",
            actor: pullRequest.user?.login ?? "github",
            eventType: nextStatus === "merged" ? "pr_merged" : nextStatus === "closed" ? "status_changed" : json.action === "opened" ? "pr_opened" : "pr_updated",
            details: {
              action: json.action,
              merged: pullRequest.merged ?? false,
              mergeCommitSha: pullRequest.merge_commit_sha ?? null,
              prNumber: pullRequest.number
            }
          });
        }
      } catch (error) {
        console.error("release trace sync failed", error);
      }

      await supabase
        .from("incidents")
        .update({
          hotfix_pr_status: nextStatus,
          hotfix_branch: pullRequest.head?.ref ?? null,
          hotfix_base_branch: pullRequest.base?.ref ?? null,
          hotfix_pr_url: pullRequest.html_url ?? null,
          hotfix_merge_sha: nextStatus === "merged" ? pullRequest.merge_commit_sha ?? null : undefined,
          status: nextStatus === "merged" ? "resolved" : "investigating",
          fix_approved_at: nextStatus === "merged" ? pullRequest.merged_at ?? new Date().toISOString() : undefined,
          updated_at: new Date().toISOString()
        })
        .eq("repo_full_name", repoFullName)
        .eq("hotfix_pr_number", pullRequest.number);

      // Handle reverse sync PR merge (main → develop sync after hotfix)
      if (nextStatus === "merged") {
        await supabase
          .from("incidents")
          .update({
            reverse_sync_pr_status: "merged",
            reverse_sync_merged_at: pullRequest.merged_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq("repo_full_name", repoFullName)
          .eq("reverse_sync_pr_number", pullRequest.number);
      }
    }

    return NextResponse.json({
      type: "pull_request",
      action: json.action,
      number: pullRequest.number,
      state: pullRequest.state,
      status: nextStatus,
      updated
    });
  }

  if (event === "delete" && isBranchDeleteEvent(json)) {
    const { data, error } = await supabase
      .from("specs")
      .update({
        status: "closed",
        updated_at: new Date().toISOString(),
        error_message: "The GitHub source branch was deleted."
      })
      .eq("repo_full_name", json.repository.full_name)
      .eq("branch_name", json.ref)
      .in("status", ["pending_pr", "draft_created"])
      .select("id");

    if (error) {
      return NextResponse.json({ error: "Unable to sync branch delete webhook.", detail: error.message }, { status: 500 });
    }

    try {
      const { data: traces } = await supabase
        .from("release_traces")
        .select("id")
        .eq("repo_full_name", json.repository.full_name)
        .eq("source_branch", json.ref)
        .in("status", ["draft", "ready_for_review", "approved", "release_pending", "failed"]);

      if (traces?.length) {
        const now = new Date().toISOString();
        await supabase
          .from("release_traces")
          .update({
            status: "cancelled",
            current_phase: "closed",
            pending_action: null,
            updated_at: now
          })
          .in("id", traces.map((trace) => trace.id));

        await supabase.from("trace_events").insert(
          traces.map((trace) => ({
            trace_id: trace.id,
            event_type: "status_changed",
            actor: "github",
            actor_type: "github",
            source: "github",
            details: {
              action: "branch_deleted",
              branch: json.ref,
              repo: json.repository.full_name
            }
          }))
        );
      }
    } catch (traceError) {
      console.error("Unable to sync release trace branch deletion", traceError);
    }

    return NextResponse.json({
      type: "branch_delete",
      branch: json.ref,
      updated: data?.length ?? 0
    });
  }

  return NextResponse.json({ ignored: true, event });
}
