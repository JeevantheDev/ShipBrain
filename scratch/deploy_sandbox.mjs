import { Octokit } from "@octokit/rest";
import fs from "node:fs";
import path from "node:path";

function loadEnvFile(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, "utf8")
        .split(/\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        })
    );
  } catch {
    return {};
  }
}

async function main() {
  const env = { ...process.env, ...loadEnvFile(path.join(process.cwd(), ".env.local")) };
  const token = env.GITHUB_TEST_TOKEN || env.GITHUB_TOKEN || env.GITHUB_PAT;
  if (!token) {
    throw new Error("No GITHUB_TEST_TOKEN or GITHUB_TOKEN found in env");
  }

  const octokit = new Octokit({ auth: token });
  
  const owner = "JeevantheDev";
  const repo = "shipbrain_sandbox";
  
  const releaseTag = `release-v2026.05.27-debug-${Date.now().toString().slice(-4)}`;
  
  console.log(`Getting latest commit on main...`);
  const { data: refData } = await octokit.git.getRef({
    owner,
    repo,
    ref: "heads/main"
  });
  const sha = refData.object.sha;
  console.log(`Latest commit SHA: ${sha}`);
  
  console.log(`Creating release tag ${releaseTag} on commit ${sha}...`);
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/tags/${releaseTag}`,
    sha
  });
  
  console.log(`Dispatching ShipBrain Production Deploy workflow for tag ${releaseTag}...`);
  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: "shipbrain-production.yml",
    ref: releaseTag,
    inputs: {
      release_tag: releaseTag,
      release_sha: sha,
      is_hotfix: "false",
      reverse_sync: "false"
    }
  });
  
  console.log("Successfully dispatched production deploy workflow!");
}

main().catch(console.error);
