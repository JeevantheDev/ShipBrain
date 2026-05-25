import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getLatestProductionUrl } from "@/lib/vercel/client";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

/**
 * Simplified deployment queue that actively checks GitHub for status
 * Clear stages:
 * - DEVELOP: awaiting_preview → preview_deploying → preview_ready → ready_for_release_pr
 * - PRODUCTION: pending_production_deploy → deploying → deployed
 */
export async function GET() {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get all specs that might need attention - explicitly exclude deployed ones
  const { data: specs, error: specsError } = await supabase
    .from("specs")
    .select("*")
    .eq("user_id", user.id)
    .in("status", ["merged", "draft_created", "pending_pr"])
    .not("release_status", "eq", "deployed")
    .order("updated_at", { ascending: false })
    .limit(20);

  if (specsError) {
    return NextResponse.json({ error: "Unable to load specs.", detail: specsError.message }, { status: 500 });
  }

  const octokit = getOctokit();
  const queue: any[] = [];

  for (const spec of specs ?? []) {
    const plan = spec.decomposed_tasks as { prTitle?: string } | null;
    const title = plan?.prTitle ?? `PR #${spec.pr_number}`;

    // Skip if already fully deployed (double-check in case DB filter missed it)
    if (spec.release_status === "deployed") continue;

    // Skip closed/abandoned specs
    if (spec.status === "closed") continue;

    // Determine the current stage
    let stage: string;
    let queueType: "develop" | "production";

    if (spec.base_branch === "develop") {
      queueType = "develop";

      // Check release PR status if we have one
      if (spec.release_pr_number && spec.release_pr_status === "merged") {
        // Release PR is merged - check if already deployed
        if (spec.release_status === "deployed") {
          continue; // Already deployed, skip
        }
        queueType = "production";
        stage = spec.release_status === "deploying" ? "deploying" : "pending_production_deploy";
      } else if (spec.release_pr_number) {
        // Release PR exists but not merged - remove from develop queue
        // Once release PR is created, the item should no longer appear in develop queue
        // It will only appear in production queue when release PR is merged
        continue;
      } else if (spec.preview_url || spec.preview_status === "deployed") {
        // Preview is ready - can create release PR
        stage = "preview_ready";
      } else if (spec.preview_status === "deploying") {
        stage = "preview_deploying";
      } else if (spec.status === "merged") {
        // Merged to develop but no preview yet
        stage = "awaiting_preview";
      } else {
        // PR not merged yet - skip
        continue;
      }
    } else if (spec.base_branch === "main") {
      // Direct to main (hotfix flow)
      queueType = "production";

      if (spec.status === "merged") {
        if (spec.release_status === "deploying") {
          stage = "deploying";
        } else if (spec.release_status === "deployed") {
          continue; // Already deployed
        } else {
          stage = "pending_production_deploy";
        }
      } else {
        continue; // PR not merged yet
      }
    } else {
      continue; // Unknown base branch
    }

    // Also check: if release_status is pending_deploy, it's definitely production queue
    if (spec.release_status === "pending_deploy") {
      queueType = "production";
      stage = "pending_production_deploy";
    }

    // Try to actively refresh status from GitHub for production items
    // Check both "deploying" status AND items that might have been deployed but not updated
    if (queueType === "production" && spec.release_tag) {
      try {
        const { owner, repo } = splitRepo(spec.repo_full_name);

        // Try multiple workflow names for backwards compatibility
        const workflowNames = ["shipbrain-production.yml", "shipbrain-deploy.yml", "shipbrain-vercel-prod.yml"];
        let deployRun: any = null;

        for (const workflowName of workflowNames) {
          try {
            const { data: workflows } = await octokit.actions.listWorkflowRuns({
              owner,
              repo,
              workflow_id: workflowName,
              per_page: 10
            });

            // Find a run matching this release tag or SHA
            deployRun = workflows.workflow_runs.find((run: any) =>
              run.head_branch === spec.release_tag ||
              (spec.release_sha && run.head_sha === spec.release_sha) ||
              (run.display_title ?? "").includes(spec.release_tag)
            );

            if (deployRun) break;
          } catch {
            // Workflow not found, try next
            continue;
          }
        }

        if (deployRun?.status === "completed") {
          const newStatus = deployRun.conclusion === "success" ? "deployed" : "failed";
          const updateData: Record<string, any> = {
            release_status: newStatus,
            deployment_run_id: deployRun.id,
            deployment_url: deployRun.html_url,
            deployed_at: newStatus === "deployed" ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
          };

          // Fetch actual production URL from Vercel if deployed successfully
          if (newStatus === "deployed") {
            try {
              // Get Vercel project ID from repo record
              const { data: repoRecord } = await supabase
                .from("repos")
                .select("setup_metadata")
                .eq("full_name", spec.repo_full_name)
                .single();

              const vercelProjectId = (repoRecord?.setup_metadata as any)?.vercelProjectId;
              const vercelToken = process.env.VERCEL_TOKEN;

              if (vercelToken && vercelProjectId) {
                const productionUrl = await getLatestProductionUrl({
                  vercelToken,
                  projectId: vercelProjectId
                });
                if (productionUrl) {
                  updateData.production_url = productionUrl;
                }
              }
            } catch {
              // Ignore errors fetching production URL
            }
          }

          await supabase.from("specs").update(updateData).eq("id", spec.id);

          if (newStatus === "deployed") continue; // Skip, it's done
          stage = "deploy_failed";
        }
      } catch {
        // Ignore errors, use cached status
      }
    }

    queue.push({
      id: spec.id,
      queueType,
      stage,
      prNumber: spec.pr_number,
      prUrl: spec.pr_url,
      title,
      repo: spec.repo_full_name,
      branchName: spec.branch_name,
      baseBranch: spec.base_branch,
      deploymentStatus: spec.deployment_status,
      releaseStatus: spec.release_status,
      releasePrNumber: spec.release_pr_number,
      releasePrUrl: spec.release_pr_url,
      releasePrStatus: spec.release_pr_status,
      releaseTag: spec.release_tag,
      releaseSha: spec.release_sha,
      previewUrl: spec.preview_url,
      previewStatus: spec.preview_status,
      previewBranchAlias: spec.preview_branch_alias,
      productionUrl: spec.production_url,
      mergeSha: spec.merge_sha,
      mergedAt: spec.merged_at,
      ciRunId: spec.latest_ci_run_id ? String(spec.latest_ci_run_id) : undefined,
      updatedAt: spec.updated_at
    });
  }

  // Sort by updated time, production items first
  queue.sort((a, b) => {
    if (a.queueType !== b.queueType) {
      return a.queueType === "production" ? -1 : 1;
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return NextResponse.json(queue);
}
