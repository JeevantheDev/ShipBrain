/**
 * Unified Action: Get Deployment Context
 *
 * Provides fresh metadata about the repository's current deployment state.
 * Used by AI Chat and Telegram to have up-to-date context before responding.
 */

import { SupabaseClient } from "@supabase/supabase-js";
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
  repoFullName: string
): Promise<DeploymentContext> {
  const context: DeploymentContext = {
    repoFullName,
    currentProduction: null,
    currentPreview: null,
    recentDeployments: [],
    recentRollbacks: [],
    productionFeatures: [],
    pendingReleases: [],
    recentActivity: [],
    summary: "",
    fetchedAt: new Date().toISOString()
  };

  try {
    // 1. Get current production release (most recent deployed spec)
    const { data: prodSpec } = await db
      .from("specs")
      .select("id, release_tag, release_sha, deployed_at, decomposed_tasks")
      .eq("repo_full_name", repoFullName)
      .eq("user_id", userId)
      .eq("release_status", "deployed")
      .order("deployed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (prodSpec) {
      context.currentProduction = {
        releaseTag: prodSpec.release_tag,
        releaseSha: prodSpec.release_sha,
        deployedAt: prodSpec.deployed_at,
        specId: prodSpec.id,
        title: (prodSpec.decomposed_tasks as any)?.prTitle || null
      };
    }

    // 2. Get current preview deployment
    const { data: previewSpec } = await db
      .from("specs")
      .select("id, branch_name, preview_url, preview_deployed_at, updated_at")
      .eq("repo_full_name", repoFullName)
      .eq("user_id", userId)
      .eq("preview_status", "deployed")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (previewSpec) {
      context.currentPreview = {
        branch: previewSpec.branch_name,
        previewUrl: previewSpec.preview_url,
        deployedAt: previewSpec.preview_deployed_at || previewSpec.updated_at,
        specId: previewSpec.id
      };
    }

    // 3. Get recent deployments
    const { data: recentSpecs } = await db
      .from("specs")
      .select("id, release_tag, release_status, deployed_at, updated_at, decomposed_tasks")
      .eq("repo_full_name", repoFullName)
      .eq("user_id", userId)
      .in("release_status", ["deployed", "rolled_back", "deploying"])
      .order("updated_at", { ascending: false })
      .limit(5);

    if (recentSpecs) {
      context.recentDeployments = recentSpecs.map(s => ({
        type: s.release_status === "rolled_back" ? "rollback" as const : "production" as const,
        releaseTag: s.release_tag,
        deployedAt: s.deployed_at || s.updated_at,
        specId: s.id,
        title: (s.decomposed_tasks as any)?.prTitle || null
      }));
    }

    // 4. Get recent rollbacks
    const { data: rollbacks } = await db
      .from("rollback_history")
      .select("source_release_tag, target_release_tag, initiated_at, status")
      .eq("repo_full_name", repoFullName)
      .eq("user_id", userId)
      .order("initiated_at", { ascending: false })
      .limit(3);

    if (rollbacks) {
      context.recentRollbacks = rollbacks.map(r => ({
        sourceTag: r.source_release_tag,
        targetTag: r.target_release_tag,
        initiatedAt: r.initiated_at,
        status: r.status
      }));
    }

    // 5. Get features currently in production (linked to current release)
    if (context.currentProduction?.releaseTag) {
      const { data: features } = await db
        .from("specs")
        .select("id, decomposed_tasks, pr_number, release_tag")
        .eq("repo_full_name", repoFullName)
        .eq("user_id", userId)
        .eq("release_status", "deployed")
        .eq("release_tag", context.currentProduction.releaseTag)
        .limit(10);

      if (features) {
        context.productionFeatures = features.map(f => ({
          specId: f.id,
          title: (f.decomposed_tasks as any)?.prTitle || null,
          prNumber: f.pr_number,
          releaseTag: f.release_tag
        }));
      }
    }

    // 6. Get pending releases
    const { data: pending } = await db
      .from("specs")
      .select("id, release_tag, release_status, release_pr_number")
      .eq("repo_full_name", repoFullName)
      .eq("user_id", userId)
      .in("release_status", ["ready_for_prod", "pending_deploy", "deploying"])
      .order("updated_at", { ascending: false })
      .limit(5);

    if (pending) {
      context.pendingReleases = pending.map(p => ({
        specId: p.id,
        releaseTag: p.release_tag,
        status: p.release_status,
        prNumber: p.release_pr_number
      }));
    }

    // 7. Get recent trace activity
    const { data: traces } = await db
      .from("release_traces")
      .select("id, title")
      .eq("repo_full_name", repoFullName)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(5);

    if (traces?.length) {
      const traceIds = traces.map(t => t.id);
      const { data: events } = await db
        .from("trace_events")
        .select("event_type, trace_id, created_at, actor, details")
        .in("trace_id", traceIds)
        .order("created_at", { ascending: false })
        .limit(10);

      if (events) {
        const traceMap = new Map(traces.map(t => [t.id, t.title]));
        context.recentActivity = events.map(e => ({
          eventType: e.event_type,
          traceTitle: traceMap.get(e.trace_id) || null,
          createdAt: e.created_at,
          actor: e.actor,
          details: e.details || {}
        }));
      }
    }

    // 8. Build summary for AI
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

  // Current production
  if (ctx.currentProduction?.releaseTag) {
    parts.push(`Current production: ${ctx.currentProduction.releaseTag} (deployed ${formatRelativeTime(ctx.currentProduction.deployedAt)})`);
  } else {
    parts.push("No production deployment yet.");
  }

  // Current preview
  if (ctx.currentPreview?.previewUrl) {
    parts.push(`Preview: ${ctx.currentPreview.branch || "develop"} branch is live.`);
  }

  // Recent rollbacks
  if (ctx.recentRollbacks.length > 0) {
    const latest = ctx.recentRollbacks[0];
    parts.push(`Last rollback: ${latest.sourceTag} → ${latest.targetTag} (${latest.status}, ${formatRelativeTime(latest.initiatedAt)})`);
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

  // Production features count
  if (ctx.productionFeatures.length > 0) {
    parts.push(`Features in production: ${ctx.productionFeatures.length}`);
  }

  // Recent activity
  if (ctx.recentActivity.length > 0) {
    const latestEvent = ctx.recentActivity[0];
    parts.push(`Latest activity: ${latestEvent.eventType.replace(/_/g, " ")} (${formatRelativeTime(latestEvent.createdAt)})`);
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
  userId: string
): Promise<Array<{ repoFullName: string; summary: string; currentTag: string | null }>> {
  const { data: repos } = await db
    .from("repos")
    .select("full_name")
    .eq("user_id", userId);

  if (!repos?.length) return [];

  const summaries: Array<{ repoFullName: string; summary: string; currentTag: string | null }> = [];

  for (const repo of repos) {
    const ctx = await getRepoDeploymentContext(db, userId, repo.full_name);
    summaries.push({
      repoFullName: repo.full_name,
      summary: ctx.summary,
      currentTag: ctx.currentProduction?.releaseTag || null
    });
  }

  return summaries;
}
