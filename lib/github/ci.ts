import { getOctokit } from "@/lib/github/client";

export async function getWorkflowRuns(owner: string, repo: string, token?: string) {
  const octokit = getOctokit(token);
  const { data } = await octokit.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 20 });
  return data.workflow_runs;
}

export async function getRunLogs(owner: string, repo: string, runId: number, token?: string) {
  const octokit = getOctokit(token);
  const response = await octokit.actions.downloadWorkflowRunLogs({
    owner,
    repo,
    run_id: runId
  });
  return String(response.data).slice(0, 12000);
}
