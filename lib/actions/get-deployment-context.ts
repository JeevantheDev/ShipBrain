/**
 * Unified Action: Get Deployment Context
 *
 * Provides fresh metadata about the repository's current deployment state.
 * Used by AI Chat and Telegram to have up-to-date context before responding.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOctokit } from "@/lib/github/client";
import { logAction, logError } from "./utils";
import { ActionContext } from "./types";

export interface DeploymentContext {
  /** Repository full name */
  repoFullName: string;
  /** Current production release info */
  currentProduction: {
    releaseTag: string | null;
    releaseSha: string | null;
    deployedAt: string | null;
    specId: string | null;
    title: string | null;
  } | null;
  /** Current preview deployment info */
  currentPreview: {
    branch: string | null;
    previewUrl: string | null;
    deployedAt: string | null;
    specId: string | null;
  } | null;
  /** Recent deployments (last 5) */
  recentDeployments: Array<{
    type: "production" | "preview" | "rollback";
    releaseTag: string | null;
    deployedAt: string;
    specId: string;
    title: string | null;
  }>;
  /** Recent rollbacks (last 3) */
  recentRollbacks: Array<{
    sourceTag: string;
    targetTag: string;
    initiatedAt: string;
    status: string;
  }>;
  /** Features currently in production */
  productionFeatures: Array<{
    specId: string;
    title: string | null;
    prNumber: number | null;
    releaseTag: string | null;
  }>;
  /** Pending releases waiting for deployment */
  pendingReleases: Array<{
    specId: string;
    releaseTag: string | null;
    status: string;
    prNumber: number | null;
  }>;
  /** Recent trace events (last 10) */
  recentActivity: Array<{
    eventType: string;
    traceTitle: string | null;
    createdAt: string;
    actor: string | null;
    details: Record<string, unknown>;
  }>;
  /** Recent commits on main branch (for incident analysis) */
  recentMainCommits: Array<{
    sha: string;
    shortSha: string;
    message: string;
    author: string | null;
    date: string;
    url: string;
  }>;
  /** Recent commits on develop branch */
  recentDevelopCommits: Array<{
    sha: string;
    shortSha: string;
    message: string;
    author: string | null;
    date: string;
    url: string;
  }>;
  /** Commits on develop that are not yet on main (pending for release) */
  pendingCommits: Array<{
    sha: string;
    shortSha: string;
    message: string;
    author: string | null;
    date: string;
  }>;
  /** Branch comparison summary */
  branchComparison: {
    developAhead: number;
    developBehind: number;
    lastSyncedAt: string | null;
  } | null;
  /** Summary for AI context */
  summary: string;
  /** Timestamp when this context was fetched */
  fetchedAt: string;
}

/**
 * Get fresh deployment context for a repository
 * This should be called before AI/Telegram responds to deployment queries
 */
export async function getRepoDeploymentContext(
  db: SupabaseClient,
  userId: string,
  repoFullName: string,
  options?: {
    githubToken?: string;
    /** Skip GitHub API calls for faster response (default: true for performance) */
    includeGitHubData?: boolean;
  }
): Promise<DeploymentContext> {
  const { githubToken, includeGitHubData = false } = options ?? {};
  const context: DeploymentContext = {
    repoFullName,
    currentProduction: null,
    currentPreview: null,
    recentDeployments: [],
    recentRollbacks: [],
    productionFeatures: [],
    pendingReleases: [],
    recentActivity: [],
    recentMainCommits: [],
    recentDevelopCommits: [],
    pendingCommits: [],
    branchComparison: null,
    summary: "",
    fetchedAt: new Date().toISOString()
  };

  try {
    // Run all independent database queries in parallel for better performance
    const [
      prodSpecResult,
      previewSpecResult,
      recentSpecsResult,
      rollbacksResult,
      pendingResult,
      tracesResult
    ] = await Promise.all([
      // 1. Get current production release
      db.from("specs")
        .select("id, release_tag, release_sha, deployed_at, decomposed_tasks")
        .eq("repo_full_name", repoFullName)
        .eq("user_id", userId)
        .eq("release_status", "deployed")
        .order("deployed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // 2. Get current preview deployment
      db.from("specs")
        .select("id, branch_name, preview_url, preview_deployed_at, updated_at")
        .eq("repo_full_name", repoFullName)
        .eq("user_id", userId)
        .eq("preview_status", "deployed")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // 3. Get recent deployments
      db.from("specs")
        .select("id, release_tag, release_status, deployed_at, updated_at, decomposed_tasks")
        .eq("repo_full_name", repoFullName)
        .eq("user_id", userId)
        .in("release_status", ["deployed", "rolled_back", "deploying"])
        .order("updated_at", { ascending: false })
        .limit(5),
      // 4. Get recent rollbacks
      db.from("rollback_history")
        .select("source_release_tag, target_release_tag, initiated_at, status")
        .eq("repo_full_name", repoFullName)
        .eq("user_id", userId)
        .order("initiated_at", { ascending: false })
        .limit(3),
      // 5. Get pending releases
      db.from("specs")
        .select("id, release_tag, release_status, release_pr_number")
        .eq("repo_full_name", repoFullName)
        .eq("user_id", userId)
        .in("release_status", ["ready_for_prod", "pending_deploy", "deploying"])
        .order("updated_at", { ascending: false })
        .limit(5),
      // 6. Get recent traces (for activity)
      db.from("release_traces")
        .select("id, title")
        .eq("repo_full_name", repoFullName)
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(5)
    ]);

    // Process production spec
    const prodSpec = prodSpecResult.data;
    if (prodSpec) {
      context.currentProduction = {
        releaseTag: prodSpec.release_tag,
        releaseSha: prodSpec.release_sha,
        deployedAt: prodSpec.deployed_at,
        specId: prodSpec.id,
        title: (prodSpec.decomposed_tasks as any)?.prTitle || null
      };
    }

    // Process preview spec
    const previewSpec = previewSpecResult.data;
    if (previewSpec) {
      context.currentPreview = {
        branch: previewSpec.branch_name,
        previewUrl: previewSpec.preview_url,
        deployedAt: previewSpec.preview_deployed_at || previewSpec.updated_at,
        specId: previewSpec.id
      };
    }

    // Process recent deployments
    const recentSpecs = recentSpecsResult.data;
    if (recentSpecs) {
      context.recentDeployments = recentSpecs.map(s => ({
        type: s.release_status === "rolled_back" ? "rollback" as const : "production" as const,
        releaseTag: s.release_tag,
        deployedAt: s.deployed_at || s.updated_at,
        specId: s.id,
        title: (s.decomposed_tasks as any)?.prTitle || null
      }));
    }

    // Process rollbacks
    const rollbacks = rollbacksResult.data;
    if (rollbacks) {
      context.recentRollbacks = rollbacks.map(r => ({
        sourceTag: r.source_release_tag,
        targetTag: r.target_release_tag,
        initiatedAt: r.initiated_at,
        status: r.status
      }));
    }

    // Process pending releases
    const pending = pendingResult.data;
    if (pending) {
      context.pendingReleases = pending.map(p => ({
        specId: p.id,
        releaseTag: p.release_tag,
        status: p.release_status,
        prNumber: p.release_pr_number
      }));
    }

    // Run dependent queries in parallel (features + trace events)
    const traces = tracesResult.data;
    const dependentQueries: Promise<any>[] = [];

    // Features query depends on currentProduction
    if (context.currentProduction?.releaseTag) {
      dependentQueries.push(
        Promise.resolve(
          db.from("specs")
            .select("id, decomposed_tasks, pr_number, release_tag")
            .eq("repo_full_name", repoFullName)
            .eq("user_id", userId)
            .eq("release_status", "deployed")
            .eq("release_tag", context.currentProduction.releaseTag)
            .limit(10)
        ).then(result => ({ type: 'features', data: result.data }))
      );
    }

    // Trace events query depends on traces
    if (traces?.length) {
      const traceIds = traces.map(t => t.id);
      dependentQueries.push(
        Promise.resolve(
          db.from("trace_events")
            .select("event_type, trace_id, created_at, actor, details")
            .in("trace_id", traceIds)
            .order("created_at", { ascending: false })
            .limit(10)
        ).then(result => ({ type: 'events', data: result.data, traces }))
      );
    }

    // Wait for dependent queries
    if (dependentQueries.length > 0) {
      const dependentResults = await Promise.all(dependentQueries);
      for (const result of dependentResults) {
        if (result.type === 'features' && result.data) {
          context.productionFeatures = result.data.map((f: any) => ({
            specId: f.id,
            title: (f.decomposed_tasks as any)?.prTitle || null,
            prNumber: f.pr_number,
            releaseTag: f.release_tag
          }));
        } else if (result.type === 'events' && result.data) {
          const traceMap = new Map(result.traces.map((t: any) => [t.id, t.title]));
          context.recentActivity = result.data.map((e: any) => ({
            eventType: e.event_type,
            traceTitle: traceMap.get(e.trace_id) || null,
            createdAt: e.created_at,
            actor: e.actor,
            details: e.details || {}
          }));
        }
      }
    }

    // 8. Optionally fetch GitHub data (commits and branch comparison)
    // This is disabled by default for performance - enable with includeGitHubData: true
    if (includeGitHubData) {
      let token = githubToken;
      if (!token) {
        try {
          const adminDb = getSupabaseAdminClient();
          const { data: profile } = await adminDb
            .from("profiles")
            .select("github_access_token")
            .eq("id", userId)
            .maybeSingle();
          token = profile?.github_access_token || undefined;
        } catch (err) {
          console.error("[getRepoDeploymentContext] Failed to get GitHub token:", err);
        }
      }

      if (token) {
        const [owner, repo] = repoFullName.split("/");
        if (owner && repo) {
          try {
            const octokit = getOctokit(token);

            // Run all GitHub API calls in parallel for better performance
            const [mainCommitsResult, developCommitsResult, comparisonResult] = await Promise.allSettled([
              // Main branch commits
              octokit.repos.listCommits({ owner, repo, sha: "main", per_page: 10 })
                .catch(async (err: any) => {
                  if (err.status === 404) {
                    return octokit.repos.listCommits({ owner, repo, sha: "master", per_page: 10 });
                  }
                  throw err;
                }),
              // Develop branch commits
              octokit.repos.listCommits({ owner, repo, sha: "develop", per_page: 10 }),
              // Branch comparison
              octokit.repos.compareCommits({ owner, repo, base: "main", head: "develop" })
                .catch(async (err: any) => {
                  if (err.status === 404) {
                    return octokit.repos.compareCommits({ owner, repo, base: "master", head: "develop" });
                  }
                  throw err;
                })
            ]);

            // Process main commits
            if (mainCommitsResult.status === "fulfilled") {
              context.recentMainCommits = mainCommitsResult.value.data.map(c => ({
                sha: c.sha,
                shortSha: c.sha.slice(0, 7),
                message: c.commit.message.split("\n")[0] || "Commit",
                author: c.commit.author?.name || c.author?.login || null,
                date: c.commit.author?.date || new Date().toISOString(),
                url: c.html_url
              }));
            }

            // Process develop commits
            if (developCommitsResult.status === "fulfilled") {
              context.recentDevelopCommits = developCommitsResult.value.data.map(c => ({
                sha: c.sha,
                shortSha: c.sha.slice(0, 7),
                message: c.commit.message.split("\n")[0] || "Commit",
                author: c.commit.author?.name || c.author?.login || null,
                date: c.commit.author?.date || new Date().toISOString(),
                url: c.html_url
              }));
            }

            // Process branch comparison
            if (comparisonResult.status === "fulfilled") {
              const comparison = comparisonResult.value.data;
              context.branchComparison = {
                developAhead: comparison.ahead_by,
                developBehind: comparison.behind_by,
                lastSyncedAt: comparison.merge_base_commit?.commit?.author?.date || null
              };
              context.pendingCommits = comparison.commits.slice(0, 10).map(c => ({
                sha: c.sha,
                shortSha: c.sha.slice(0, 7),
                message: c.commit.message.split("\n")[0] || "Commit",
                author: c.commit.author?.name || c.author?.login || null,
                date: c.commit.author?.date || new Date().toISOString()
              }));
            }
          } catch (githubErr) {
            console.error("[getRepoDeploymentContext] GitHub API error:", githubErr);
          }
        }
      }
    }

    // 9. Build summary for AI
    context.summary = buildContextSummary(context);

  } catch (error) {
    console.error("[getRepoDeploymentContext] Error:", error);
  }

  return context;
}

/**
 * Build a human-readable summary for AI context
 */
function buildContextSummary(ctx: DeploymentContext): string {
  const parts: string[] = [];

  // Current production — more descriptive
  if (ctx.currentProduction?.releaseTag) {
    const deployedWhen = formatRelativeTime(ctx.currentProduction.deployedAt);
    const titleHint = ctx.currentProduction.title ? ` ("${ctx.currentProduction.title.slice(0, 40)}")` : "";
    parts.push(`Production: ${ctx.currentProduction.releaseTag}${titleHint}, deployed ${deployedWhen}`);
  } else {
    parts.push("No production deployment yet.");
  }

  // Current preview — include branch name
  if (ctx.currentPreview?.previewUrl) {
    const branch = ctx.currentPreview.branch ?? "develop";
    parts.push(`Preview: branch \`${branch}\` is live at ${ctx.currentPreview.previewUrl}`);
  }

  // Recent rollbacks — describe source → target clearly
  if (ctx.recentRollbacks.length > 0) {
    const latest = ctx.recentRollbacks[0];
    parts.push(`Last rollback: ${latest.sourceTag} → ${latest.targetTag} (${latest.status}, ${formatRelativeTime(latest.initiatedAt)})`);
  }

  // Branch comparison — meaningful message
  if (ctx.branchComparison) {
    const { developAhead, developBehind } = ctx.branchComparison;
    if (developAhead > 0 && developBehind > 0) {
      parts.push(`Develop is ${developAhead} commits ahead and ${developBehind} commits behind main (diverged)`);
    } else if (developAhead > 0) {
      parts.push(`Develop is ${developAhead} commit${developAhead > 1 ? "s" : ""} ahead of main — ready for release`);
    } else {
      parts.push("Develop is in sync with main");
    }
  }

  // Pending commits — list authors for at-a-glance context
  if (ctx.pendingCommits.length > 0) {
    const authors = [...new Set(ctx.pendingCommits.map(c => c.author).filter(Boolean))];
    const authorHint = authors.length ? ` by ${authors.slice(0, 2).join(", ")}${authors.length > 2 ? " and others" : ""}` : "";
    parts.push(`${ctx.pendingCommits.length} commit${ctx.pendingCommits.length > 1 ? "s" : ""} pending release${authorHint}`);
  }

  // Pending releases
  if (ctx.pendingReleases.length > 0) {
    const pendingTags = ctx.pendingReleases
      .filter(p => p.releaseTag)
      .map(p => p.releaseTag)
      .join(", ");
    if (pendingTags) {
      parts.push(`Pending releases: ${pendingTags}`);
    }
  }

  // Production features — list titles not just count
  if (ctx.productionFeatures.length > 0) {
    const titles = ctx.productionFeatures
      .slice(0, 2)
      .map(f => f.title ? `"${f.title.slice(0, 30)}"` : `PR #${f.prNumber}`)
      .join(", ");
    const more = ctx.productionFeatures.length > 2 ? ` +${ctx.productionFeatures.length - 2} more` : "";
    parts.push(`Features in production: ${titles}${more}`);
  }

  // Latest activity — cleaner event type phrasing
  if (ctx.recentActivity.length > 0) {
    const latestEvent = ctx.recentActivity[0];
    const eventLabel = latestEvent.eventType.replace(/_/g, " ");
    const actor = latestEvent.actor ? ` by ${latestEvent.actor}` : "";
    parts.push(`Latest activity: ${eventLabel}${actor} (${formatRelativeTime(latestEvent.createdAt)})`);
  }

  // Latest main commit — show short sha + message
  if (ctx.recentMainCommits.length > 0) {
    const latest = ctx.recentMainCommits[0];
    const msg = latest.message.slice(0, 50) + (latest.message.length > 50 ? "…" : "");
    parts.push(`Latest main commit: [${latest.shortSha}] "${msg}" (${formatRelativeTime(latest.date)})`);
  }

  return parts.join(" | ");
}


/**
 * Format a date as relative time
 */
function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "unknown";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Get deployment context for all user's repos (for Telegram/AI overview)
 */
export async function getAllReposDeploymentContext(
  db: SupabaseClient,
  userId: string,
  options?: { includeGitHubData?: boolean }
): Promise<Array<{
  repoFullName: string;
  summary: string;
  currentTag: string | null;
  pendingCommitsCount: number;
  developAhead: number;
}>> {
  const { data: repos } = await db
    .from("repos")
    .select("full_name")
    .eq("user_id", userId);

  if (!repos?.length) return [];

  const summaries: Array<{
    repoFullName: string;
    summary: string;
    currentTag: string | null;
    pendingCommitsCount: number;
    developAhead: number;
  }> = [];

  for (const repo of repos) {
    const ctx = await getRepoDeploymentContext(db, userId, repo.full_name, {
      includeGitHubData: options?.includeGitHubData ?? false
    });
    summaries.push({
      repoFullName: repo.full_name,
      summary: ctx.summary,
      currentTag: ctx.currentProduction?.releaseTag || null,
      pendingCommitsCount: ctx.pendingCommits.length,
      developAhead: ctx.branchComparison?.developAhead || 0
    });
  }

  return summaries;
}
