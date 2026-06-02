/**
 * Unified Actions Layer - Utilities
 *
 * Shared utilities used by all actions.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { getOctokit } from "@/lib/github/client";
import { ActionContext, ActionResult, ChainUpdate, Spec, ReleaseTrace, TraceStatus } from "./types";

// ============================================================================
// Logging
// ============================================================================

export function logAction(
  action: string,
  context: ActionContext,
  data: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  console.log(
    `[Action:${action}] [${timestamp}] [source:${context.source}] [user:${context.userId}] [repo:${context.repoFullName}]`,
    JSON.stringify(data)
  );
}

export function logError(
  action: string,
  context: ActionContext,
  error: unknown
): void {
  const timestamp = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[Action:${action}:ERROR] [${timestamp}] [source:${context.source}] [user:${context.userId}] [repo:${context.repoFullName}]`,
    message
  );
}

// ============================================================================
// Repository Utilities
// ============================================================================

export function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

// ============================================================================
// Spec Utilities
// ============================================================================

export async function getSpecById(
  db: SupabaseClient,
  specId: string
): Promise<Spec | null> {
  const { data } = await db
    .from("specs")
    .select("*")
    .eq("id", specId)
    .maybeSingle();
  return data;
}

export async function getSpecByPrNumber(
  db: SupabaseClient,
  repoFullName: string,
  prNumber: number
): Promise<Spec | null> {
  const { data } = await db
    .from("specs")
    .select("*")
    .eq("repo_full_name", repoFullName)
    .eq("pr_number", prNumber)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function getLinkedSpecs(
  db: SupabaseClient,
  repoFullName: string,
  releaseTag?: string | null,
  releasePrNumber?: number | null
): Promise<Spec[]> {
  let query = db
    .from("specs")
    .select("*")
    .eq("repo_full_name", repoFullName);

  if (releaseTag) {
    query = query.eq("release_tag", releaseTag);
  } else if (releasePrNumber) {
    query = query.eq("release_pr_number", releasePrNumber);
  } else {
    return [];
  }

  const { data } = await query;
  return data ?? [];
}

export async function updateSpec(
  db: SupabaseClient,
  specId: string,
  updates: Partial<Spec>,
  chainUpdates: ChainUpdate[]
): Promise<void> {
  const { data: oldSpec } = await db
    .from("specs")
    .select("*")
    .eq("id", specId)
    .maybeSingle();

  await db
    .from("specs")
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq("id", specId);

  // Track chain updates
  for (const [field, newValue] of Object.entries(updates)) {
    if (oldSpec && oldSpec[field] !== newValue) {
      chainUpdates.push({
        type: "spec",
        id: specId,
        field,
        oldValue: oldSpec[field],
        newValue
      });
    }
  }
}

export async function updateLinkedSpecs(
  db: SupabaseClient,
  repoFullName: string,
  releaseTag: string | null,
  releasePrNumber: number | null,
  updates: Partial<Spec>,
  excludeSpecId?: string
): Promise<number> {
  let query = db
    .from("specs")
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq("repo_full_name", repoFullName);

  if (releaseTag) {
    query = query.eq("release_tag", releaseTag);
  } else if (releasePrNumber) {
    query = query.eq("release_pr_number", releasePrNumber);
  } else {
    return 0;
  }

  if (excludeSpecId) {
    query = query.neq("id", excludeSpecId);
  }

  const { data } = await query.select("id");
  return data?.length ?? 0;
}

// ============================================================================
// Release Trace Utilities
// ============================================================================

export async function getTraceBySpecId(
  db: SupabaseClient,
  specId: string
): Promise<ReleaseTrace | null> {
  const { data } = await db
    .from("release_traces")
    .select("*")
    .eq("spec_id", specId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function getTracesByReleaseTag(
  db: SupabaseClient,
  repoFullName: string,
  releaseTag: string
): Promise<ReleaseTrace[]> {
  const { data } = await db
    .from("release_traces")
    .select("*")
    .eq("repo_full_name", repoFullName)
    .eq("release_tag", releaseTag);
  return data ?? [];
}

export async function updateTrace(
  db: SupabaseClient,
  traceId: string,
  updates: Partial<ReleaseTrace>,
  chainUpdates: ChainUpdate[]
): Promise<void> {
  const { data: oldTrace } = await db
    .from("release_traces")
    .select("*")
    .eq("id", traceId)
    .maybeSingle();

  await db
    .from("release_traces")
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq("id", traceId);

  // Track chain updates
  for (const [field, newValue] of Object.entries(updates)) {
    if (oldTrace && oldTrace[field] !== newValue) {
      chainUpdates.push({
        type: "trace",
        id: traceId,
        field,
        oldValue: oldTrace[field],
        newValue
      });
    }
  }
}

export async function updateLinkedTraces(
  db: SupabaseClient,
  repoFullName: string,
  releaseTag: string | null,
  releasePrNumber: number | null,
  updates: Partial<ReleaseTrace>,
  excludeTraceId?: string
): Promise<number> {
  let query = db
    .from("release_traces")
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq("repo_full_name", repoFullName);

  if (releaseTag) {
    query = query.eq("release_tag", releaseTag);
  } else if (releasePrNumber) {
    query = query.eq("release_pr_number", releasePrNumber);
  } else {
    return 0;
  }

  if (excludeTraceId) {
    query = query.neq("id", excludeTraceId);
  }

  const { data } = await query.select("id");
  return data?.length ?? 0;
}

export async function addTraceEvent(
  db: SupabaseClient,
  traceId: string,
  event: {
    eventType: string;
    source: string;
    actor: string;
    actorType: string;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  await db.from("trace_events").insert({
    trace_id: traceId,
    event_type: event.eventType,
    source: event.source,
    actor: event.actor,
    actor_type: event.actorType,
    details: event.details ?? {},
    created_at: new Date().toISOString()
  });
}

// ============================================================================
// GitHub Utilities
// ============================================================================

export async function getPRStatus(
  token: string,
  repoFullName: string,
  prNumber: number
): Promise<{ merged: boolean; state: string; mergeCommitSha: string | null }> {
  const octokit = getOctokit(token);
  const { owner, repo } = splitRepo(repoFullName);

  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber
  });

  return {
    merged: pr.merged,
    state: pr.state,
    mergeCommitSha: pr.merge_commit_sha ?? null
  };
}

export async function getLatestCommitSha(
  token: string,
  repoFullName: string,
  branch: string
): Promise<string> {
  const octokit = getOctokit(token);
  const { owner, repo } = splitRepo(repoFullName);

  const { data: ref } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`
  });

  return ref.object.sha;
}

// ============================================================================
// Notification Utilities
// ============================================================================

export async function createNotification(
  db: SupabaseClient,
  userId: string,
  notification: {
    type: string;
    title: string;
    body: string;
    href?: string;
    severity?: "info" | "warning" | "error" | "success";
    repoFullName?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await db.from("notifications").insert({
    user_id: userId,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    href: notification.href,
    severity: notification.severity ?? "info",
    repo_full_name: notification.repoFullName,
    metadata: notification.metadata ?? {},
    created_at: new Date().toISOString()
  });
}

// ============================================================================
// Result Helpers
// ============================================================================

export function success<T>(
  message: string,
  data: T,
  chainUpdates?: ChainUpdate[]
): ActionResult<T> {
  return {
    ok: true,
    message,
    data,
    chainUpdates
  };
}

export function failure<T = never>(error: string, chainUpdates?: ChainUpdate[]): ActionResult<T> {
  return {
    ok: false,
    message: error,
    error,
    chainUpdates
  };
}
