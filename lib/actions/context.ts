/**
 * Unified Actions Layer - Context Builder
 *
 * Builds ActionContext for different sources (UI, Chat, Telegram, Webhook).
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { ActionContext, ActionSource } from "./types";

/**
 * Build an ActionContext from user session data
 */
export async function buildActionContext(params: {
  db: SupabaseClient;
  userId: string;
  source: ActionSource;
  repoFullName?: string;
  actor?: string;
}): Promise<ActionContext | null> {
  const { db, userId, source, repoFullName, actor } = params;

  // Get user's GitHub token
  const { data: profile } = await db
    .from("profiles")
    .select("github_access_token, email")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.github_access_token) {
    return null;
  }

  // If no repo specified, try to get the user's most recently active repo
  let resolvedRepoFullName = repoFullName;
  if (!resolvedRepoFullName) {
    const { data: recentRepo } = await db
      .from("repos")
      .select("full_name")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    resolvedRepoFullName = recentRepo?.full_name || "";
  }

  return {
    db,
    userId,
    githubToken: profile.github_access_token,
    source,
    actor: actor || profile.email || userId,
    repoFullName: resolvedRepoFullName || ""
  };
}

/**
 * Build an ActionContext for internal/system operations
 */
export function buildSystemContext(params: {
  db: SupabaseClient;
  userId: string;
  githubToken: string;
  repoFullName: string;
}): ActionContext {
  return {
    db: params.db,
    userId: params.userId,
    githubToken: params.githubToken,
    source: "system",
    actor: "ShipBrain System",
    repoFullName: params.repoFullName
  };
}

/**
 * Build an ActionContext for webhook operations
 */
export function buildWebhookContext(params: {
  db: SupabaseClient;
  userId: string;
  githubToken: string;
  repoFullName: string;
  webhookSource: string;
}): ActionContext {
  return {
    db: params.db,
    userId: params.userId,
    githubToken: params.githubToken,
    source: "webhook",
    actor: `${params.webhookSource} webhook`,
    repoFullName: params.repoFullName
  };
}
