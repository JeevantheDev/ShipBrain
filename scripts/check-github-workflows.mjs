import fs from "node:fs";
import path from "node:path";
import { Octokit } from "@octokit/rest";

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
  const token = env.GITHUB_TOKEN || env.GITHUB_PAT || env.OCTOKIT_TOKEN;
  if (!token) {
    console.error("No GITHUB_TOKEN found");
    return;
  }

  const octokit = new Octokit({ auth: token });
  const owner = "JeevantheDev";
  const repo = "shipbrain_sandbox";

  try {
    const { data } = await octokit.actions.listRepoWorkflows({ owner, repo });
    console.log("=== Workflows on GitHub ===");
    console.log(JSON.stringify(data.workflows, null, 2));

    // Try fetching the content of shipbrain-preview.yml on develop and main
    for (const branch of ["main", "develop"]) {
      try {
        const fileContent = await octokit.repos.getContent({
          owner,
          repo,
          path: ".github/workflows/shipbrain-preview.yml",
          ref: branch
        });
        console.log(`\n=== .github/workflows/shipbrain-preview.yml on branch: ${branch} ===`);
        const content = Buffer.from(fileContent.data.content, "base64").toString("utf8");
        console.log(content);
      } catch (err) {
        console.log(`.github/workflows/shipbrain-preview.yml not found on branch: ${branch}`);
      }
    }
  } catch (err) {
    console.error(err);
  }
}

main().catch(console.error);
