#!/usr/bin/env node
/**
 * Reset ShipBrain Sandbox Repository
 *
 * This script:
 * 1. Deletes all branches except main
 * 2. Deletes all release tags
 * 3. Removes ShipBrain workflow files and generated content
 * 4. Commits and pushes changes
 *
 * Usage: npm run prod:reset-sandbox
 *        node scripts/reset-sandbox-repo.mjs [--repo-path /path/to/repo] [--github-repo owner/repo]
 */

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// Default configuration
const DEFAULT_REPO_PATH = "/Users/jeevanjyotidash/Developer/shipbrain_sandbox";
const DEFAULT_GITHUB_REPO = "JeevantheDev/shipbrain_sandbox";

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    repoPath: DEFAULT_REPO_PATH,
    githubRepo: DEFAULT_GITHUB_REPO,
    dryRun: args.includes("--dry-run"),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-path" && args[i + 1]) {
      config.repoPath = args[i + 1];
    }
    if (args[i] === "--github-repo" && args[i + 1]) {
      config.githubRepo = args[i + 1];
    }
  }

  return config;
}

function exec(cmd, options = {}) {
  console.log(`> ${cmd}`);
  if (options.dryRun) {
    console.log("  (dry run - skipped)");
    return "";
  }
  try {
    return execSync(cmd, { encoding: "utf8", stdio: "pipe", ...options }).trim();
  } catch (error) {
    if (options.ignoreError) {
      console.log(`  (ignored error: ${error.message})`);
      return "";
    }
    throw error;
  }
}

async function main() {
  const config = parseArgs();
  console.log("=".repeat(60));
  console.log("ShipBrain Sandbox Repository Reset");
  console.log("=".repeat(60));
  console.log(`Repo path: ${config.repoPath}`);
  console.log(`GitHub repo: ${config.githubRepo}`);
  if (config.dryRun) console.log("DRY RUN MODE - no changes will be made");
  console.log("");

  // Verify repo exists
  if (!fs.existsSync(config.repoPath)) {
    throw new Error(`Repository not found at: ${config.repoPath}`);
  }

  const cwd = config.repoPath;
  const execOpts = { cwd, dryRun: config.dryRun };

  // Step 1: Fetch all remote branches
  console.log("\n[1/5] Fetching remote branches...");
  exec("git fetch --all --prune", { cwd });

  // Step 2: Get list of remote branches (excluding main)
  console.log("\n[2/5] Deleting remote branches (except main)...");
  const branchOutput = exec("git branch -r", { cwd });
  const remoteBranches = branchOutput
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("origin/") && !b.includes("origin/main") && !b.includes("origin/HEAD"))
    .map((b) => b.replace("origin/", ""));

  for (const branch of remoteBranches) {
    exec(`git push origin --delete "${branch}"`, { ...execOpts, ignoreError: true });
  }
  console.log(`  Deleted ${remoteBranches.length} branches`);

  // Step 3: Delete all release tags (release-*, hotfix-*, v* semver tags)
  console.log("\n[3/5] Deleting release tags...");
  const tagOutput = exec("git tag -l 'release-*' && git tag -l 'hotfix-*' && git tag -l 'v*'", { cwd });
  const tags = [...new Set(tagOutput.split("\n").filter(Boolean))]; // dedupe

  for (const tag of tags) {
    exec(`git push origin --delete "${tag}"`, { ...execOpts, ignoreError: true });
    exec(`git tag -d "${tag}"`, { ...execOpts, ignoreError: true });
  }
  console.log(`  Deleted ${tags.length} tags`);

  // Step 4: Remove ShipBrain files
  console.log("\n[4/5] Removing ShipBrain files...");
  exec("git checkout main", { cwd });
  exec("git pull origin main", { cwd });

  // Remove ALL ShipBrain files for clean onboarding test
  const filesToRemove = [
    ".github/workflows/shipbrain-*.yml",
    "SHIPBRAIN_HANDOFF.md",
    "SHIPBRAIN_INCIDENT_HOTFIX.md",
    "shipbrain/",
    "tickets/",
    "shipbrain.json",
    "vercel.json",
  ];

  for (const pattern of filesToRemove) {
    const fullPath = path.join(config.repoPath, pattern);
    if (!config.dryRun) {
      exec(`rm -rf ${pattern}`, { cwd, ignoreError: true });
    }
  }

  // Step 5: Commit and push
  console.log("\n[5/5] Committing and pushing changes...");
  const status = exec("git status --porcelain", { cwd });
  if (status) {
    exec("git add -A", execOpts);
    exec('git commit -m "chore: reset repo for fresh ShipBrain onboarding"', execOpts);
    exec("git push origin main", execOpts);
    console.log("  Changes committed and pushed");
  } else {
    console.log("  No changes to commit");
  }

  console.log("\n" + "=".repeat(60));
  console.log("Sandbox repository reset complete!");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("\nError:", error.message);
  process.exit(1);
});
