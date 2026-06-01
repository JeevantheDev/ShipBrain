import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getLatestProductionUrl, getPreviewUrlForSha } from "@/lib/cloudflare/client";
import { createOrUpdateTrace, updateTraceBySpec } from "@/lib/orchestrator";
import { getNextSemverReleaseTag } from "@/lib/shipbrain/semver";

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

  // Deduplicate specs by pr_number + repo_full_name to prevent showing same PR twice
  // Keep the most recently updated spec when duplicates exist
  const seenPrs = new Map<string, typeof specs[0]>();
  const deduplicatedSpecs: typeof specs = [];

  for (const spec of specs ?? []) {
    if (!spec.pr_number) {
      // No PR number, can't be a duplicate
      deduplicatedSpecs.push(spec);
      continue;
    }

    const key = `${spec.repo_full_name}:${spec.pr_number}`;
    const existing = seenPrs.get(key);

    if (!existing) {
      seenPrs.set(key, spec);
      deduplicatedSpecs.push(spec);
    } else {
      // Keep the one with more complete data or more recent update
      const existingScore = (existing.merge_sha ? 1 : 0) + (existing.release_tag ? 1 : 0) + (existing.preview_url ? 1 : 0);
      const newScore = (spec.merge_sha ? 1 : 0) + (spec.release_tag ? 1 : 0) + (spec.preview_url ? 1 : 0);

      if (newScore > existingScore || (newScore === existingScore && new Date(spec.updated_at) > new Date(existing.updated_at))) {
        // Replace the existing one with this more complete/recent one
        const idx = deduplicatedSpecs.findIndex(s => s.id === existing.id);
        if (idx !== -1) {
          deduplicatedSpecs[idx] = spec;
        }
        seenPrs.set(key, spec);
      }
      // Otherwise keep the existing one (do nothing)
    }
  }

  const nextSemverTagsCache = new Map<string, string>();
  const getCachedNextSemverTag = async (repoName: string) => {
    if (!repoName) return "v1.0.0";
    if (nextSemverTagsCache.has(repoName)) {
      return nextSemverTagsCache.get(repoName)!;
    }
    const tag = await getNextSemverReleaseTag(supabase, repoName);
    nextSemverTagsCache.set(repoName, tag);
    return tag;
  };

  for (const rawSpec of deduplicatedSpecs) {
    const spec = { ...rawSpec };

    // Skip ShipBrain setup specs - they are for configuration, not deployments
    if (spec.branch_name?.startsWith("shipbrain/setup")) {
      continue;
    }

    if (spec.pr_number && spec.repo_full_name && ["draft_created", "pending_pr"].includes(spec.status)) {
      try {
        const { owner, repo } = splitRepo(spec.repo_full_name);
        const { data: pr } = await octokit.pulls.get({
          owner,
          repo,
          pull_number: spec.pr_number
        });

        const nextStatus = pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft_created" : "pending_pr";
        const nextBaseBranch = pr.base?.ref ?? spec.base_branch;
        const nextBranchName = pr.head?.ref ?? spec.branch_name;
        const nextMergeSha = pr.merged ? pr.merge_commit_sha ?? spec.merge_sha : spec.merge_sha;

        if (
          nextStatus !== spec.status ||
          nextBaseBranch !== spec.base_branch ||
          nextBranchName !== spec.branch_name ||
          nextMergeSha !== spec.merge_sha
        ) {
          const updates: Record<string, any> = {
            status: nextStatus,
            pr_url: pr.html_url ?? spec.pr_url,
            branch_name: nextBranchName,
            base_branch: nextBaseBranch,
            feature_head_sha: pr.head?.sha ?? spec.feature_head_sha,
            feature_last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          if (nextStatus === "merged") {
            updates.merged_at = pr.merged_at ?? new Date().toISOString();
            updates.merge_sha = nextMergeSha;
            if (nextBaseBranch === "develop" && !spec.release_status) {
              updates.release_status = "ready_for_prod";
            } else if (nextBaseBranch === "main" && spec.release_status !== "deployed" && spec.release_status !== "deploying") {
              // Both hotfix PRs and release PRs (develop -> main) should be pending_deploy
              updates.release_status = "pending_deploy";
              updates.release_pr_status = "merged";
            }
          }

          await supabase.from("specs").update(updates).eq("id", spec.id);
          Object.assign(spec, updates);

          await createOrUpdateTrace({
            repoFullName: spec.repo_full_name,
            type: nextBranchName?.startsWith("hotfix/") ? "hotfix" : nextBranchName === "develop" && nextBaseBranch === "main" ? "release" : "feature",
            title: pr.title ?? `PR #${spec.pr_number}`,
            description: pr.body ?? null,
            status: nextStatus === "merged" ? nextBaseBranch === "main" ? "merged_main" : "merged_develop" : nextStatus === "closed" ? "cancelled" : pr.draft ? "draft" : "ready_for_review",
            sourceBranch: nextBranchName ?? spec.branch_name,
            targetBranch: nextBaseBranch ?? spec.base_branch,
            draftPrNumber: spec.pr_number,
            draftPrUrl: pr.html_url ?? spec.pr_url,
            releasePrNumber: nextBranchName === "develop" && nextBaseBranch === "main" ? spec.pr_number : null,
            releasePrUrl: nextBranchName === "develop" && nextBaseBranch === "main" ? pr.html_url ?? spec.pr_url : null,
            specId: spec.id,
            source: "github",
            actor: "ShipBrain sync",
            eventType: nextStatus === "merged" ? "pr_merged" : "pr_updated",
            details: {
              prNumber: spec.pr_number,
              merged: pr.merged,
              mergeCommitSha: nextMergeSha,
              syncSource: "deployment_queue"
            }
          });
        }
      } catch (error) {
        console.error("Unable to reconcile PR for deployment queue", error);
      }
    }

    const plan = spec.decomposed_tasks as { prTitle?: string; type?: string } | null;
    const isOnboarding = plan?.type === "onboarding";
    const title = isOnboarding
      ? `🚀 Initial Release ${spec.release_tag || "v1.0.0"}`
      : plan?.prTitle ?? `PR #${spec.pr_number}`;

    // First check if this spec itself has a release PR (Telegram flow stores it on the same spec)
    let linkedReleasePrNumber = spec.release_pr_number;
    let linkedReleasePrUrl = spec.release_pr_url;
    let linkedReleasePrStatus = spec.release_pr_status;
    let linkedReleaseStatus = spec.release_status;

    // Skip if already fully deployed (double-check in case DB filter missed it)
    if (spec.release_status === "deployed") continue;

    // Skip closed/abandoned specs
    if (spec.status === "closed") continue;

    // Skip ShipBrain setup branches - they are repo configuration, not product releases
    if (spec.branch_name?.startsWith("shipbrain/setup")) continue;

    // Determine the current stage
    let stage: string;
    let queueType: "develop" | "production";
    const isReleasePromotionSpec = spec.branch_name === "develop" && spec.base_branch === "main";

    if (spec.base_branch === "develop") {
      queueType = "develop";

      if (!linkedReleasePrNumber) {
        // Find active (non-deployed, non-closed) release PRs for this repo
        const { data: releaseSpec } = await supabase
          .from("specs")
          .select("pr_number, pr_url, status, release_status, release_pr_status")
          .eq("user_id", user.id)
          .eq("repo_full_name", spec.repo_full_name)
          .eq("branch_name", "develop")
          .eq("base_branch", "main")
          .not("status", "eq", "closed")
          .not("release_status", "eq", "deployed")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (releaseSpec?.pr_number) {
          linkedReleasePrNumber = releaseSpec.pr_number;
          linkedReleasePrUrl = releaseSpec.pr_url;
          linkedReleasePrStatus = releaseSpec.release_pr_status ?? (releaseSpec.status === "merged" ? "merged" : releaseSpec.status === "pending_pr" || releaseSpec.status === "draft_created" ? "open" : releaseSpec.status);
          linkedReleaseStatus = releaseSpec.release_status ?? linkedReleaseStatus;
        }
      }

      // Don't skip features with linked release PR - show them with "Review Release PR" button
      // Only skip if the release PR is already merged (it will show in production queue)
      if (linkedReleasePrNumber && linkedReleasePrStatus === "merged") {
        continue; // Release PR is merged, production deploy pending
      }

      if (spec.preview_url || spec.preview_status === "deployed") {
        stage = "preview_ready";
      } else if (spec.preview_status === "deploying") {
        // Actively verify the preview run hasn't already completed — prevents stale badge
        let resolvedPreviewStage = "preview_deploying";
        try {
          const { owner: pOwner, repo: pRepo } = splitRepo(spec.repo_full_name);
          const { data: previewRuns } = await octokit.actions.listWorkflowRuns({
            owner: pOwner,
            repo: pRepo,
            workflow_id: "shipbrain-preview.yml",
            per_page: 10
          });
          const mergeSha = spec.merge_sha;
          const matchRun = previewRuns.workflow_runs.find((r: any) =>
            mergeSha ? r.head_sha === mergeSha : r.head_branch === "develop"
          );

          if (!matchRun) {
            // No matching run found — workflow was never dispatched or already cleared.
            // Reset to awaiting_preview so the user can retry.
            await supabase.from("specs").update({
              preview_status: null,
              updated_at: new Date().toISOString()
            }).eq("id", spec.id);
            resolvedPreviewStage = "awaiting_preview";
          } else if (matchRun.status === "completed") {
            if (matchRun.conclusion === "success") {
              // Run succeeded — mark deployed and attempt to get preview URL from Cloudflare
              const updateData: Record<string, any> = {
                preview_status: "deployed",
                updated_at: new Date().toISOString()
              };

              let previewUrl: string | null = null;
              try {
                // Get Cloudflare credentials from repo record
                const { data: repoRecord } = await supabase
                  .from("repos")
                  .select("setup_metadata")
                  .eq("full_name", spec.repo_full_name)
                  .single();

                const cloudflareProjectName = (repoRecord?.setup_metadata as any)?.cloudflareProjectName;
                const cloudflareAccountId = (repoRecord?.setup_metadata as any)?.cloudflareAccountId;
                const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

                if (cloudflareApiToken && cloudflareAccountId && cloudflareProjectName && spec.merge_sha) {
                  previewUrl = await getPreviewUrlForSha({
                    apiToken: cloudflareApiToken,
                    accountId: cloudflareAccountId,
                    projectName: cloudflareProjectName,
                    sha: spec.merge_sha
                  });
                  if (previewUrl) {
                    updateData.preview_url = previewUrl;
                  }
                }
              } catch (err) {
                console.error("Error fetching preview URL during active sync:", err);
              }

              await supabase.from("specs").update(updateData).eq("id", spec.id);

              // Update release trace to preview_live
              await updateTraceBySpec(spec.id, {
                status: "preview_live",
                current_phase: "preview",
                preview_deployment: {
                  status: "deployed",
                  url: previewUrl,
                  branch: "develop",
                  timestamp: new Date().toISOString()
                }
              }, {
                eventType: "preview_deployed",
                source: "github",
                actor: "github-actions",
                actorType: "system",
                details: {
                  previewUrl,
                  runUrl: matchRun.html_url,
                  prNumber: spec.pr_number
                }
              }).catch((err) => console.error("Failed to update trace for preview:", err));

              resolvedPreviewStage = "preview_ready";
            } else {
              // Run failed — reset so user can retry
              await supabase.from("specs").update({
                preview_status: "failed",
                updated_at: new Date().toISOString()
              }).eq("id", spec.id);
              resolvedPreviewStage = "awaiting_preview";
            }
          }
          // If still in_progress / queued, keep preview_deploying
        } catch {
          // If GitHub check fails, keep showing deploying — don't break the queue
        }
        stage = resolvedPreviewStage;
      } else if (spec.status === "merged") {
        // Merged to develop but no preview yet
        stage = "awaiting_preview";
      } else {
        // PR not merged yet - skip
        continue;
      }
    } else if (spec.base_branch === "main") {
      queueType = "production";

      if (spec.incident_id && spec.status !== "merged") {
        stage = "hotfix_pr_open";
      } else if (isReleasePromotionSpec && spec.status !== "merged") {
        stage = "release_pr_open";
      } else if (spec.status === "merged" && isReleasePromotionSpec) {
        if (spec.release_status === "deploying") {
          stage = "deploying";
        } else if (spec.release_status === "deployed") {
          continue;
        } else {
          stage = "pending_production_deploy";
        }
      } else if (spec.status === "merged") {
        // Direct to main hotfix flow
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

    // Specs with release_status === "pending_deploy" should show in production queue
    // This handles feature specs whose release PR has been merged
    if (spec.release_status === "pending_deploy" && spec.release_pr_status === "merged") {
      queueType = "production";
      stage = "pending_production_deploy";
    }

    // Try to actively refresh status from GitHub for production items
    // Check both "deploying" status AND items that might have been deployed but not updated
    if (queueType === "production" && spec.release_tag) {
      try {
        const { owner, repo } = splitRepo(spec.repo_full_name);

        // Try multiple workflow names for backwards compatibility
        const workflowNames = ["shipbrain-production.yml", "shipbrain-deploy.yml"];
        let deployRun: any = null;

        // The production workflow is dispatched with ref=releaseTag, so head_branch === releaseTag.
        // Match priority: (1) exact SHA, (2) head_branch === release tag, (3) display title.
        for (const workflowName of workflowNames) {
          try {
            const { data: workflows } = await octokit.actions.listWorkflowRuns({
              owner,
              repo,
              workflow_id: workflowName,
              per_page: 15
            });

            deployRun = workflows.workflow_runs.find((run: any) =>
              (spec.release_sha && run.head_sha === spec.release_sha) ||
              (spec.release_tag && run.head_branch === spec.release_tag) ||
              (spec.release_tag && (run.display_title ?? "").includes(spec.release_tag))
            );

            if (deployRun) break;
          } catch {
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

          // Fetch actual production URL from Cloudflare if deployed successfully
          if (newStatus === "deployed") {
            try {
              // Get Cloudflare credentials from repo record
              const { data: repoRecord } = await supabase
                .from("repos")
                .select("setup_metadata")
                .eq("full_name", spec.repo_full_name)
                .single();

              const cloudflareProjectName = (repoRecord?.setup_metadata as any)?.cloudflareProjectName;
              const cloudflareAccountId = (repoRecord?.setup_metadata as any)?.cloudflareAccountId;
              const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

              if (cloudflareApiToken && cloudflareAccountId && cloudflareProjectName) {
                const productionUrl = await getLatestProductionUrl({
                  apiToken: cloudflareApiToken,
                  accountId: cloudflareAccountId,
                  projectName: cloudflareProjectName
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
      linkedReleaseStatus,
      releasePrNumber: isReleasePromotionSpec ? spec.pr_number : linkedReleasePrNumber,
      releasePrUrl: isReleasePromotionSpec ? spec.pr_url : linkedReleasePrUrl,
      releasePrStatus: isReleasePromotionSpec ? spec.release_pr_status : linkedReleasePrStatus,
      releaseTag: spec.release_tag || await getCachedNextSemverTag(spec.repo_full_name),
      releaseSha: spec.release_sha,
      previewUrl: spec.preview_url,
      previewStatus: spec.preview_status,
      previewBranchAlias: spec.preview_branch_alias,
      productionUrl: spec.production_url,
      mergeSha: spec.merge_sha,
      mergedAt: spec.merged_at,
      ciRunId: spec.latest_ci_run_id ? String(spec.latest_ci_run_id) : undefined,
      updatedAt: spec.updated_at,
      isOnboarding
    });
  }

  // Consolidate develop queue items by repo and stage
  // This prevents duplicate "Start preview deploy" buttons for the same repo
  const developByRepoAndStage = new Map<string, any[]>();
  const otherItems: any[] = [];

  for (const item of queue) {
    // Consolidate develop queue items (awaiting_preview, preview_deploying, preview_ready) by repo
    if (item.queueType === "develop" && ["awaiting_preview", "preview_deploying", "preview_ready"].includes(item.stage)) {
      const key = `${item.repo}:${item.stage}`;
      const existing = developByRepoAndStage.get(key) ?? [];
      existing.push(item);
      developByRepoAndStage.set(key, existing);
    } else {
      otherItems.push(item);
    }
  }

  // Create consolidated items for each repo/stage combination
  const consolidatedQueue: any[] = [...otherItems];

  for (const [key, features] of developByRepoAndStage) {
    const [repo, stage] = key.split(":");

    // Sort features by mergedAt (most recent first)
    features.sort((a, b) => new Date(b.mergedAt ?? b.updatedAt).getTime() - new Date(a.mergedAt ?? a.updatedAt).getTime());

    const mostRecent = features[0];
    const featureCount = features.length;

    // Check if ANY feature has a release PR (not just the most recent)
    const featureWithReleasePr = features.find(f => f.releasePrNumber);
    const releasePrNumber = featureWithReleasePr?.releasePrNumber ?? mostRecent.releasePrNumber;
    const releasePrUrl = featureWithReleasePr?.releasePrUrl ?? mostRecent.releasePrUrl;
    const releasePrStatus = featureWithReleasePr?.releasePrStatus ?? mostRecent.releasePrStatus;

    // Create consolidated item
    consolidatedQueue.push({
      id: mostRecent.id,
      queueType: "develop",
      stage,
      prNumber: mostRecent.prNumber,
      prUrl: mostRecent.prUrl,
      title: featureCount > 1
        ? stage === "awaiting_preview"
          ? `${featureCount} features awaiting preview`
          : stage === "preview_deploying"
            ? `${featureCount} features deploying`
            : `${featureCount} features ready for release`
        : mostRecent.title,
      repo,
      branchName: mostRecent.branchName,
      baseBranch: mostRecent.baseBranch,
      deploymentStatus: mostRecent.deploymentStatus,
      releaseStatus: featureWithReleasePr?.releaseStatus ?? mostRecent.releaseStatus,
      linkedReleaseStatus: featureWithReleasePr?.linkedReleaseStatus ?? mostRecent.linkedReleaseStatus,
      releasePrNumber,
      releasePrUrl,
      releasePrStatus,
      releaseTag: featureWithReleasePr?.releaseTag ?? mostRecent.releaseTag,
      releaseSha: featureWithReleasePr?.releaseSha ?? mostRecent.releaseSha,
      previewUrl: mostRecent.previewUrl,
      previewStatus: mostRecent.previewStatus,
      previewBranchAlias: mostRecent.previewBranchAlias,
      productionUrl: mostRecent.productionUrl,
      mergeSha: mostRecent.mergeSha,
      mergedAt: mostRecent.mergedAt,
      ciRunId: mostRecent.ciRunId,
      updatedAt: mostRecent.updatedAt,
      // Include all features for display
      includedFeatures: features.map(f => ({
        id: f.id,
        prNumber: f.prNumber,
        prUrl: f.prUrl,
        title: f.title,
        branchName: f.branchName,
        mergedAt: f.mergedAt
      })),
      featureCount
    });
  }

  // Sort by updated time, production items first
  consolidatedQueue.sort((a, b) => {
    if (a.queueType !== b.queueType) {
      return a.queueType === "production" ? -1 : 1;
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return NextResponse.json(consolidatedQueue);
}
