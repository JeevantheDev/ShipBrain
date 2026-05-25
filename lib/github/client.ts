import { Octokit } from "@octokit/rest";

export function getOctokit(token?: string) {
  return new Octokit({
    auth: token ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_TEST_TOKEN
  });
}
