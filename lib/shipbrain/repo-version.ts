/**
 * Repo Version Management
 *
 * Simplified version tracking for repositories. The `current_version` column
 * on the repos table is the single source of truth for production version.
 *
 * This is updated ONLY on:
 *   1. Successful release deployment
 *   2. Successful hotfix deployment
 *   3. Successful rollback deployment
 */

import { SupabaseClient } from "@supabase/supabase-js";

export type VersionUpdateType = "release" | "hotfix" | "rollback";

export interface UpdateRepoVersionInput {
  repoFullName: string;
  version: string;
  sha?: string | null;
  type: VersionUpdateType;
}

/**
 * Update the current production version for a repository.
 * This should ONLY be called after a successful production deployment.
 */
export async function updateRepoCurrentVersion(
  db: SupabaseClient,
  input: UpdateRepoVersionInput
): Promise<{ ok: boolean; error?: string }> {
  const { repoFullName, version, sha, type } = input;

  if (!repoFullName || !version) {
    return { ok: false, error: "Missing required fields: repoFullName and version" };
  }

  const { error } = await db
    .from("repos")
    .update({
      current_version: version,
      current_version_sha: sha || null,
      current_version_deployed_at: new Date().toISOString(),
      current_version_type: type
    })
    .eq("full_name", repoFullName);

  if (error) {
    console.error(`[updateRepoCurrentVersion] Failed to update ${repoFullName}:`, error);
    return { ok: false, error: error.message };
  }

  console.log(`[updateRepoCurrentVersion] Updated ${repoFullName} to ${version} (${type})`);
  return { ok: true };
}

/**
 * Get the current production version for a repository.
 */
export async function getRepoCurrentVersion(
  db: SupabaseClient,
  repoFullName: string
): Promise<{
  version: string | null;
  sha: string | null;
  deployedAt: string | null;
  type: VersionUpdateType | null;
}> {
  const { data, error } = await db
    .from("repos")
    .select("current_version, current_version_sha, current_version_deployed_at, current_version_type")
    .eq("full_name", repoFullName)
    .maybeSingle();

  if (error || !data) {
    return { version: null, sha: null, deployedAt: null, type: null };
  }

  return {
    version: data.current_version,
    sha: data.current_version_sha,
    deployedAt: data.current_version_deployed_at,
    type: data.current_version_type as VersionUpdateType | null
  };
}
