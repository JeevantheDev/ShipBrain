import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { updateTraceBySpecOrPr } from "@/lib/orchestrator";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getLatestPreviewUrl, getLatestProductionUrl, getPreviewUrlForSha } from "@/lib/cloudflare/client";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

/**
 * Active refresh endpoint - checks GitHub directly for latest status
 * This doesn't rely on webhooks and gives accurate real-time data
 *
 * POST with { specId } - refresh a specific spec
 * POST with { discover: true, repoFullName } - discover and create specs for merged PRs
 */
export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const specId = body.specId;
  const discover = body.discover === true;
  const repoFullName = body.repoFullName;

  // Discovery mode - find and create specs for merged PRs that don't have specs
  if (discover && repoFullName) {
    const octokit = getOctokit();
    const { owner, repo } = splitRepo(repoFullName);
    const created: any[] = [];

    try {
      // Get recently merged PRs from GitHub
      const { data: pulls } = await octokit.pulls.list({
        owner,
        repo,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 20
      });

      const mergedPrs = pulls.filter(pr => pr.merged_at);

      for (const pr of mergedPrs) {
        // Check if spec already exists for this PR
        const { data: existingSpec } = await supabase
          .from("specs")
          .select("id")
          .eq("repo_full_name", repoFullName)
          .eq("pr_number", pr.number)
          .maybeSingle();

        if (!existingSpec) {
          // Create spec for this PR
          const baseBranch = pr.base?.ref ?? "develop";
          const { data: newSpec, error: insertError } = await supabase
            .from("specs")
            .insert({
              user_id: user.id,
              raw_spec: pr.body ?? pr.title ?? "",
              decomposed_tasks: { prTitle: pr.title },
              status: "merged",
              repo_full_name: repoFullName,
              branch_name: pr.head?.ref,
              base_branch: baseBranch,
              pr_number: pr.number,
              pr_url: pr.html_url,
              merged_at: pr.merged_at,
              merge_sha: pr.merge_commit_sha ?? null,
              feature_head_sha: pr.head?.sha ?? null,
              release_status: baseBranch === "main" ? "pending_deploy" : "ready_for_prod",
              updated_at: new Date().toISOString()
            })
            .select("id")
            .single();

          if (!insertError && newSpec) {
            created.push({
              specId: newSpec.id,
              prNumber: pr.number,
              title: pr.title,
              baseBranch
            });
          }
        }
      }

      // Create notification if any specs were created
      if (created.length > 0) {
        await supabase
          .from("notifications")
          .insert({
            user_id: user.id,
            type: "specs_discovered",
            title: "PRs Synced",
            body: `Discovered and synced ${created.length} merged PR(s) from GitHub`,
            href: `/releases`,
            severity: "info",
            repo_full_name: repoFullName,
            metadata: { created }
          })
          .catch((err) => console.error("notification creation failed:", err));
      }

      return NextResponse.json({
        ok: true,
        discovered: created.length,
        specs: created,
        message: created.length > 0 ? `Created ${created.length} spec(s) for merged PRs` : "No new PRs to sync"
      });
    } catch (error) {
      return NextResponse.json({
        error: "Failed to discover PRs from GitHub",
        detail: error instanceof Error ? error.message : "Unknown error"
      }, { status: 500 });
    }
  }

  if (!specId) {
    return NextResponse.json({ error: "specId is required (or use discover mode)" }, { status: 400 });
  }

  const { data: spec, error: specError } = await supabase
    .from("specs")
    .select("*")
    .eq("id", specId)
    .eq("user_id", user.id)
    .single();

  if (specError || !spec) {
    return NextResponse.json({ error: "Spec not found" }, { status: 404 });
  }

  const octokit = getOctokit();
  const { owner, repo } = splitRepo(spec.repo_full_name);
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };

  // Get Cloudflare credentials from repo record for URL lookups
  const { data: repoRecord } = await supabase
    .from("repos")
    .select("setup_metadata")
    .eq("full_name", spec.repo_full_name)
    .eq("user_id", user.id)
    .single();

  const cloudflareProjectName = (repoRecord?.setup_metadata as any)?.cloudflareProjectName;
  const cloudflareAccountId = (repoRecord?.setup_metadata as any)?.cloudflareAccountId;
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

  try {
    // Check feature PR status
    if (spec.pr_number) {
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: spec.pr_number
      });

      if (pr.merged) {
        updates.status = "merged";
        updates.merged_at = pr.merged_at;
        updates.merge_sha = pr.merge_commit_sha;

        // If merged to develop and no release status yet, it needs preview first
        // Do NOT set release_status here - preview must be deployed first
        // The flow is: merged → preview_deployed → release_pr_created → pending_deploy → deployed
      } else if (pr.state === "closed") {
        updates.status = "closed";
      } else {
        updates.status = pr.draft ? "draft_created" : "pending_pr";
      }
    }

    // Check release PR status (develop → main)
    if (spec.release_pr_number) {
      const { data: releasePr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: spec.release_pr_number
      });

      if (releasePr.merged) {
        updates.release_pr_status = "merged";
        updates.release_sha = releasePr.merge_commit_sha;

        // If release PR is merged but not deployed yet, mark pending_deploy
        if (spec.release_status !== "deployed" && spec.release_status !== "deploying") {
          updates.release_status = "pending_deploy";
        }
      } else if (releasePr.state === "closed") {
        updates.release_pr_status = "closed";
      } else {
        updates.release_pr_status = "open";
      }
    }

    // NOTE: We do NOT auto-detect release PRs here.
    // The flow is:
    // 1. Feature PR merged to develop → preview deploy
    // 2. User explicitly creates Release PR (develop → main) via ShipBrain UI
    // 3. Release PR merged → production deploy
    // Auto-detecting would incorrectly link unrelated old PRs to this spec.

    // Check production deployment workflow status
    // Check anytime there's a release_tag or release_sha, regardless of current status
    const shouldCheckProductionDeploy = spec.release_tag || spec.release_sha;
    const isNotFinalState = spec.release_status !== "deployed";

    if (shouldCheckProductionDeploy && isNotFinalState) {
      // Try multiple workflow names for backwards compatibility
      const workflowNames = ["shipbrain-production.yml", "shipbrain-deploy.yml"];
      let deployRun: any = null;

      const deployTriggerTime = new Date(spec.updated_at).getTime();

      for (const workflowName of workflowNames) {
        try {
          const { data: workflows } = await octokit.actions.listWorkflowRuns({
            owner,
            repo,
            workflow_id: workflowName,
            per_page: 15
          });

          // Workflow dispatched with ref=releaseTag so head_branch === releaseTag
          deployRun = workflows.workflow_runs.find((run: any) =>
            (spec.release_sha && run.head_sha === spec.release_sha) ||
            (spec.release_tag && run.head_branch === spec.release_tag) ||
            (spec.release_tag && (run.display_title ?? "").includes(spec.release_tag))
          );

          if (deployRun) break;
        } catch {
          // Workflow not found, try next
          continue;
        }
      }

      if (deployRun) {
        if (deployRun.status === "completed") {
          updates.release_status = deployRun.conclusion === "success" ? "deployed" : "failed";
          updates.deployed_at = deployRun.conclusion === "success" ? new Date().toISOString() : null;
        } else if (deployRun.status === "in_progress" || deployRun.status === "queued") {
          updates.release_status = "deploying";
        }
        updates.deployment_url = deployRun.html_url;
        updates.deployment_run_id = deployRun.id;
      }
    }

    // Check preview deployment status - check if preview is deployed even if we don't have URL yet
    // This handles case where workflow completed but callback didn't work
    const shouldCheckPreview = spec.base_branch === "develop" && spec.status === "merged" && !spec.preview_url;

    if (spec.preview_status === "deploying" || shouldCheckPreview) {
      try {
        const { data: workflows } = await octokit.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: "shipbrain-preview.yml",
          per_page: 15
        });

        // Find the preview run matching the merge commit SHA
        const mergeSha = spec.merge_sha || updates.merge_sha;
        const previewRun = workflows.workflow_runs.find((run: any) =>
          mergeSha ? run.head_sha === mergeSha : (run.head_branch === "develop" || run.head_branch === spec.branch_name)
        );

        if (previewRun) {
          if (previewRun.status === "completed") {
            if (previewRun.conclusion === "success") {
              // Get actual preview URL from Cloudflare API matching this specific SHA
              let previewUrl: string | null = null;
              if (cloudflareApiToken && cloudflareAccountId && cloudflareProjectName && mergeSha) {
                try {
                  previewUrl = await getPreviewUrlForSha({
                    apiToken: cloudflareApiToken,
                    accountId: cloudflareAccountId,
                    projectName: cloudflareProjectName,
                    sha: mergeSha
                  });
                } catch (err) {
                  console.error("Error fetching preview URL for SHA:", err);
                }
              }

              if (previewUrl) {
                updates.preview_status = "deployed";
                updates.preview_url = previewUrl;
              } else if (!cloudflareApiToken || !cloudflareAccountId || !cloudflareProjectName) {
                // Fallback to constructed URL if no Cloudflare credentials
                updates.preview_status = "deployed";
                updates.preview_url = `https://${cloudflareProjectName || repo.toLowerCase()}.pages.dev`;
              } else {
                // Cloudflare deployment not ready yet, keep in deploying status
                updates.preview_status = "deploying";
              }
            } else {
              updates.preview_status = "failed";
            }
          } else if (previewRun.status === "in_progress" || previewRun.status === "queued") {
            updates.preview_status = "deploying";
          }
        }
      } catch {
        // Preview workflow might not exist yet
      }
    }

    // Check production deployment and get actual production URL
    if (spec.release_status === "deployed" && !spec.production_url && cloudflareApiToken && cloudflareAccountId && cloudflareProjectName) {
      try {
        const productionUrl = await getLatestProductionUrl({
          apiToken: cloudflareApiToken,
          accountId: cloudflareAccountId,
          projectName: cloudflareProjectName
        });
        if (productionUrl) {
          updates.production_url = productionUrl;
        }
      } catch {
        // Ignore errors fetching production URL
      }
    }

    // Apply updates
    await supabase.from("specs").update(updates).eq("id", specId);

    if (updates.status === "closed" || updates.release_pr_status === "closed") {
      await updateTraceBySpecOrPr({
        specId,
        repoFullName: spec.repo_full_name,
        prNumber: updates.release_pr_status === "closed" ? spec.release_pr_number : spec.pr_number,
        branchName: spec.branch_name,
        patch: {
          status: "cancelled"
        },
        event: {
          eventType: "status_changed",
          source: "github",
          actor: "ShipBrain sync",
          actorType: "system",
          details: {
            reason: updates.release_pr_status === "closed" ? "release_pr_closed" : "draft_pr_closed",
            specId,
            prNumber: updates.release_pr_status === "closed" ? spec.release_pr_number : spec.pr_number
          }
        }
      }).catch((traceError) => {
        console.error("Unable to sync release trace from spec refresh", traceError);
      });
    }

    return NextResponse.json({
      ok: true,
      specId,
      updates,
      message: "Spec refreshed from GitHub"
    });
  } catch (error) {
    return NextResponse.json({
      error: "Failed to refresh spec",
      detail: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}
