import { SupabaseClient } from "@supabase/supabase-js";

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  original: string;
}

export function parseSemver(tag: string): SemverParts | null {
  if (!tag) return null;
  // Support standard semver (v1.0.0) and prefixed versions (hotfix-v1.0.3, release-v1.0.2)
  // The prefix is optional and can be: hotfix-, release-, feature-, etc.
  const match = tag.trim().match(/^(?:[\w-]+-)?v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || "",
    original: tag.trim()
  };
}

export function compareSemver(tag1: string, tag2: string): number {
  const v1 = parseSemver(tag1);
  const v2 = parseSemver(tag2);
  if (!v1 && !v2) return tag1.localeCompare(tag2);
  if (!v1) return -1;
  if (!v2) return 1;

  if (v1.major !== v2.major) return v1.major - v2.major;
  if (v1.minor !== v2.minor) return v1.minor - v2.minor;
  if (v1.patch !== v2.patch) return v1.patch - v2.patch;
  return v1.prerelease.localeCompare(v2.prerelease);
}

export function incrementPatch(tag: string): string {
  const parsed = parseSemver(tag);
  if (!parsed) {
    // If not standard semver, return a default increment
    return "v1.0.0";
  }
  const startsWithV = tag.trim().toLowerCase().startsWith("v");
  return `${startsWithV ? "v" : ""}${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export async function getNextSemverReleaseTag(db: SupabaseClient | any, repoFullName: string): Promise<string> {
  const { data, error } = await db
    .from("specs")
    .select("release_tag")
    .eq("repo_full_name", repoFullName)
    .not("release_tag", "is", null)
    .neq("release_status", "rolled_back");

  if (error || !data || data.length === 0) {
    return "v1.0.0";
  }

  const semverTags = data
    .map((row: any) => row.release_tag)
    .filter((tag: string) => parseSemver(tag) !== null);

  if (semverTags.length === 0) {
    // Check if there are non-semver release tags and try to extract something, or default to v1.0.0
    return "v1.0.0";
  }

  // Find the max semver tag
  let maxTag = semverTags[0];
  for (let i = 1; i < semverTags.length; i++) {
    if (compareSemver(semverTags[i], maxTag) > 0) {
      maxTag = semverTags[i];
    }
  }

  return incrementPatch(maxTag);
}
