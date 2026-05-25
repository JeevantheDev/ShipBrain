import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isBranchDeleteEvent, statusFromPullRequestEvent, verifyWebhookSignature } from "@/lib/github/webhooks";

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
    const workflowPrNumber = workflowRun.pull_requests?.[0]?.number ?? null;
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

    const spec = pullRequestSpec ?? releaseSpec ?? releaseTagSpec ?? mergedSpec ?? deployingSpec ?? branchSpec;

    const { error: ciError } = await supabase
      .from("ci_runs")
      .upsert(
        {
          github_run_id: workflowRun.id,
          spec_id: spec?.id ?? null,
          pr_number: spec?.pr_number ?? null,
          repo_full_name: repoFullName,
          workflow_name: workflowRun.name ?? null,
          title: workflowRun.display_title ?? workflowRun.name ?? `Workflow run #${workflowRun.id}`,
          html_url: workflowRun.html_url ?? null,
          head_sha: workflowRun.head_sha ?? null,
          event: workflowRun.event ?? null,
          branch,
          status: workflowRun.status ?? "queued",
          conclusion: workflowRun.conclusion ?? null,
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
              release_status: "ready_for_prod",
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
      } else {
        updated = 1; // Release promotion PR was handled above
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

    return NextResponse.json({
      type: "branch_delete",
      branch: json.ref,
      updated: data?.length ?? 0
    });
  }

  return NextResponse.json({ ignored: true, event });
}
