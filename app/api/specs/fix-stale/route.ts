import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOctokit } from "@/lib/github/client";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

/**
 * Fix stale specs by:
 * 1. Syncing spec status with GitHub PR status
 * 2. Fixing release PR statuses
 * 3. Ensuring pending_deploy specs show in deployment queue
 */
export async function POST() {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdminClient();
  const octokit = getOctokit();
  let fixed = 0;
  let errors: string[] = [];

  // Get all specs that might be stale - not deployed, not rolled back, and not closed
  const { data: specs, error: specsError } = await db
    .from("specs")
    .select("*")
    .eq("user_id", user.id)
    .not("release_status", "eq", "deployed")
    .not("release_status", "eq", "rolled_back")
    .not("status", "eq", "closed")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (specsError) {
    return NextResponse.json({ error: "Failed to fetch specs", detail: specsError.message }, { status: 500 });
  }

  for (const spec of specs ?? []) {
    try {
      const updates: Record<string, any> = {};

      // Check if spec has a PR and sync with GitHub
      if (spec.pr_number && spec.repo_full_name) {
        try {
          const { owner, repo } = splitRepo(spec.repo_full_name);
          const { data: pr } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: spec.pr_number
          });

          // Sync PR status
          if (pr.merged && spec.status !== "merged") {
            updates.status = "merged";
            updates.merged_at = pr.merged_at ?? new Date().toISOString();
            updates.merge_sha = pr.merge_commit_sha ?? spec.merge_sha;
          } else if (pr.state === "closed" && !pr.merged && spec.status !== "closed") {
            updates.status = "closed";
          }

          // Update base_branch if it changed
          if (pr.base?.ref && pr.base.ref !== spec.base_branch) {
            updates.base_branch = pr.base.ref;
          }

          // For merged PRs to main, ensure release status is correct
          if (pr.merged && pr.base?.ref === "main") {
            if (!spec.release_status || spec.release_status === "ready_for_prod") {
              updates.release_status = "pending_deploy";
            }
            if (!spec.release_pr_status || spec.release_pr_status !== "merged") {
              updates.release_pr_status = "merged";
            }
            if (!spec.release_sha) {
              updates.release_sha = pr.merge_commit_sha;
            }
          }
        } catch (err) {
          // PR might not exist or be inaccessible - skip GitHub sync
          console.error(`Failed to sync PR #${spec.pr_number}:`, err);
        }
      }

      // Check if spec has a release PR and sync its status
      if (spec.release_pr_number && spec.repo_full_name) {
        try {
          const { owner, repo } = splitRepo(spec.repo_full_name);
          const { data: releasePr } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: spec.release_pr_number
          });

          if (releasePr.merged) {
            if (spec.release_pr_status !== "merged") {
              updates.release_pr_status = "merged";
            }
            if (!spec.release_status || spec.release_status === "ready_for_prod") {
              updates.release_status = "pending_deploy";
            }
            if (!spec.release_sha) {
              updates.release_sha = releasePr.merge_commit_sha;
            }
            // Also update the spec status if the release PR merge means it's deployed
            if (spec.status !== "merged") {
              updates.status = "merged";
            }
          } else if (releasePr.state === "closed" && !releasePr.merged) {
            if (spec.release_pr_status !== "closed") {
              updates.release_pr_status = "closed";
            }
          } else if (releasePr.state === "open") {
            if (spec.release_pr_status !== "open") {
              updates.release_pr_status = "open";
            }
          }
        } catch (err) {
          console.error(`Failed to sync release PR #${spec.release_pr_number}:`, err);
        }
      }

      // Fix specs that are merged to main but missing release fields
      if (spec.status === "merged" && spec.base_branch === "main") {
        if (!spec.release_status) {
          updates.release_status = "pending_deploy";
        }
        if (!spec.release_pr_status) {
          updates.release_pr_status = "merged";
        }
      }

      // Apply updates if any
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();

        const { error: updateError } = await db
          .from("specs")
          .update(updates)
          .eq("id", spec.id);

        if (updateError) {
          errors.push(`Spec ${spec.id}: ${updateError.message}`);
        } else {
          fixed++;
        }
      }
    } catch (err) {
      errors.push(`Spec ${spec.id}: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  // Also scan GitHub for merged release PRs that don't have specs
  const { data: repos } = await db
    .from("repos")
    .select("full_name")
    .eq("user_id", user.id);

  for (const repo of repos ?? []) {
    try {
      const { owner, repo: repoName } = splitRepo(repo.full_name);

      // Find recently merged PRs from develop to main
      const { data: prs } = await octokit.pulls.list({
        owner,
        repo: repoName,
        state: "closed",
        base: "main",
        head: `${owner}:develop`,
        sort: "updated",
        direction: "desc",
        per_page: 5
      });

      for (const pr of prs) {
        if (!pr.merged_at) continue;

        // Check if we have a spec for this PR
        const { data: existingSpec } = await db
          .from("specs")
          .select("id, release_status, release_pr_status")
          .eq("repo_full_name", repo.full_name)
          .or(`pr_number.eq.${pr.number},release_pr_number.eq.${pr.number}`)
          .maybeSingle();

        if (existingSpec) {
          // Spec exists - ensure it has correct status
          if (existingSpec.release_status !== "deployed" && 
              existingSpec.release_status !== "pending_deploy" && 
              existingSpec.release_status !== "rolled_back") {
            await db.from("specs").update({
              release_status: "pending_deploy",
              release_pr_status: "merged",
              updated_at: new Date().toISOString()
            }).eq("id", existingSpec.id);
            fixed++;
          }
        } else {
          // No spec exists - create one for this merged release PR
          const { error: insertError } = await db
            .from("specs")
            .insert({
              user_id: user.id,
              raw_spec: `Release PR #${pr.number}: ${pr.title}`,
              decomposed_tasks: { prTitle: pr.title, type: "release" },
              status: "merged",
              repo_full_name: repo.full_name,
              branch_name: "develop",
              base_branch: "main",
              pr_number: pr.number,
              pr_url: pr.html_url,
              merged_at: pr.merged_at,
              merge_sha: pr.merge_commit_sha,
              release_sha: pr.merge_commit_sha,
              release_pr_number: pr.number,
              release_pr_url: pr.html_url,
              release_pr_status: "merged",
              release_status: "pending_deploy",
              updated_at: new Date().toISOString()
            });

          if (!insertError) {
            fixed++;
          } else {
            errors.push(`Failed to create spec for PR #${pr.number}: ${insertError.message}`);
          }
        }
      }
    } catch (err) {
      errors.push(`Failed to scan repo ${repo.full_name}: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  return NextResponse.json({
    ok: true,
    fixed,
    total: specs?.length ?? 0,
    errors: errors.length > 0 ? errors : undefined
  });
}
