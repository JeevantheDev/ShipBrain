import { getOctokit } from "@/lib/github/client";

export type GithubCommitSummary = {
  sha: string;
  shortSha: string;
  message: string;
  author?: string;
  url?: string;
};

export async function listPullRequestCommits(input: {
  owner: string;
  repo: string;
  pullNumber?: number | null;
  token?: string | null;
}): Promise<GithubCommitSummary[]> {
  if (!input.pullNumber) return [];

  const octokit = getOctokit(input.token ?? undefined);
  const { data } = await octokit.pulls.listCommits({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber,
    per_page: 50
  });

  return data.map((commit) => ({
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    message: commit.commit.message.split("\n")[0] ?? "Commit",
    author: commit.commit.author?.name ?? commit.author?.login ?? undefined,
    url: commit.html_url
  }));
}
