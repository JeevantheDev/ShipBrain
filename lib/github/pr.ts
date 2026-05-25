import { getOctokit } from "@/lib/github/client";

export type DraftPrInput = {
  owner: string;
  repo: string;
  base: string;
  branch: string;
  title: string;
  body: string;
  files: Record<string, string>;
  reviewers?: string[];
  token?: string;
  useExistingHead?: boolean;
};

export async function createDraftPR(input: DraftPrInput) {
  if (!input.token && !process.env.GITHUB_TEST_TOKEN) {
    return {
      number: 42,
      html_url: `https://github.com/${input.owner}/${input.repo}/pull/42`,
      draft: true
    };
  }

  const octokit = getOctokit(input.token);
  const { data: ref } = await octokit.git.getRef({
    owner: input.owner,
    repo: input.repo,
    ref: `heads/${input.base}`
  });

  const baseSha = ref.object.sha;

  if (input.useExistingHead) {
    // Guard: if head and base point to the same commit, GitHub rejects the PR
    // with "No commits between <base> and <head>". Create a stamp commit on head.
    try {
      const [{ data: headRefData }, { data: baseRefData }] = await Promise.all([
        octokit.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}` }),
        octokit.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.base}` })
      ]);

      if (headRefData.object.sha === baseRefData.object.sha) {
        const { data: headCommit } = await octokit.git.getCommit({
          owner: input.owner,
          repo: input.repo,
          commit_sha: headRefData.object.sha
        });
        const stampMessage = `chore: release stamp for ${input.base} promotion`;
        const { data: stampCommit } = await octokit.git.createCommit({
          owner: input.owner,
          repo: input.repo,
          message: stampMessage,
          tree: headCommit.tree.sha,
          parents: [headRefData.object.sha]
        });
        await octokit.git.updateRef({
          owner: input.owner,
          repo: input.repo,
          ref: `heads/${input.branch}`,
          sha: stampCommit.sha,
          force: false
        });
      }
    } catch {
      // If stamp fails, proceed — GitHub will surface the error with context
    }

    const { data: pr } = await octokit.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      body: input.body,
      head: input.branch,
      base: input.base,
      draft: true
    });

    return {
      number: pr.number,
      html_url: pr.html_url,
      draft: pr.draft ?? true
    };
  }


  const { data: baseCommit } = await octokit.git.getCommit({
    owner: input.owner,
    repo: input.repo,
    commit_sha: baseSha
  });

  const tree = await Promise.all(
    Object.entries(input.files).map(async ([path, content]) => {
      const { data: blob } = await octokit.git.createBlob({
        owner: input.owner,
        repo: input.repo,
        content: Buffer.from(content).toString("base64"),
        encoding: "base64"
      });
      return {
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha
      };
    })
  );

  const { data: newTree } = await octokit.git.createTree({
    owner: input.owner,
    repo: input.repo,
    base_tree: baseCommit.tree.sha,
    tree
  });

  const { data: newCommit } = await octokit.git.createCommit({
    owner: input.owner,
    repo: input.repo,
    message: input.title,
    tree: newTree.sha,
    parents: [baseSha]
  });

  await octokit.git.createRef({
    owner: input.owner,
    repo: input.repo,
    ref: `refs/heads/${input.branch}`,
    sha: newCommit.sha
  }).catch(async (error) => {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status !== 422) throw error;
    await octokit.git.updateRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${input.branch}`,
      sha: newCommit.sha,
      force: false
    });
  });

  const { data: pr } = await octokit.pulls.create({
    owner: input.owner,
    repo: input.repo,
    title: input.title,
    body: input.body,
    head: input.branch,
    base: input.base,
    draft: true
  });

  if (input.reviewers?.length) {
    await octokit.pulls.requestReviewers({
      owner: input.owner,
      repo: input.repo,
      pull_number: pr.number,
      reviewers: input.reviewers
    });
  }

  return {
    number: pr.number,
    html_url: pr.html_url,
    draft: pr.draft ?? true
  };
}

export type ClosePrInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  branch?: string;
  comment?: string;
  deleteBranch?: boolean;
  token?: string;
};

export async function closePullRequest(input: ClosePrInput) {
  const octokit = getOctokit(input.token);
  const comment = input.comment?.trim();

  if (comment) {
    await octokit.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.pullNumber,
      body: comment
    });
  }

  const { data: pr } = await octokit.pulls.update({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber,
    state: "closed"
  });

  let branchDeleted = false;
  if (input.deleteBranch && input.branch) {
    try {
      await octokit.git.deleteRef({
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.branch}`
      });
      branchDeleted = true;
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
      if (status !== 404) throw error;
    }
  }

  return {
    number: pr.number,
    html_url: pr.html_url,
    state: pr.state,
    branchDeleted
  };
}

export type MergeAndTagInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  releaseTag: string;
  token?: string;
};

export async function mergePullRequestAndTag(input: MergeAndTagInput) {
  const octokit = getOctokit(input.token);
  const { data: pull } = await octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber
  });

  if (pull.draft) {
    await octokit.graphql(
      `
        mutation MarkReady($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
            pullRequest {
              id
            }
          }
        }
      `,
      { pullRequestId: pull.node_id }
    );
  }

  const { data: merge } = await octokit.pulls.merge({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber,
    merge_method: "squash",
    commit_title: `ShipBrain release ${input.releaseTag}`
  });

  if (!merge.sha) {
    throw new Error("GitHub merged the PR but did not return a merge commit SHA.");
  }

  await octokit.git.createRef({
    owner: input.owner,
    repo: input.repo,
    ref: `refs/tags/${input.releaseTag}`,
    sha: merge.sha
  });

  return {
    merged: merge.merged,
    sha: merge.sha,
    releaseTag: input.releaseTag,
    releaseUrl: `https://github.com/${input.owner}/${input.repo}/releases/tag/${input.releaseTag}`
  };
}

export type MergePullRequestInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  commitTitle: string;
  token?: string;
};

export async function mergePullRequest(input: MergePullRequestInput) {
  const octokit = getOctokit(input.token);
  const { data: pull } = await octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber
  });

  if (pull.draft) {
    await octokit.graphql(
      `
        mutation MarkReady($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
            pullRequest {
              id
            }
          }
        }
      `,
      { pullRequestId: pull.node_id }
    );
  }

  const { data: merge } = await octokit.pulls.merge({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber,
    merge_method: "squash",
    commit_title: input.commitTitle
  });

  if (!merge.sha) {
    throw new Error("GitHub merged the hotfix PR but did not return a merge commit SHA.");
  }

  const { data: destinationRef } = await octokit.git.getRef({
    owner: input.owner,
    repo: input.repo,
    ref: `heads/${pull.base.ref}`
  });

  return {
    merged: merge.merged,
    sha: merge.sha,
    html_url: pull.html_url,
    baseBranch: pull.base.ref,
    headBranch: pull.head.ref,
    destinationSha: destinationRef.object.sha,
    mergedIntoDestination: destinationRef.object.sha === merge.sha
  };
}

export type TagMergedPrInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  releaseTag: string;
  token?: string;
};

export async function tagMergedPullRequestForRelease(input: TagMergedPrInput) {
  const octokit = getOctokit(input.token);
  const { data: pull } = await octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber
  });

  if (!pull.merged || !pull.merge_commit_sha) {
    throw new Error("Production approval requires the PR to be reviewed and merged by the development team first. Merge the PR into the develop branch, wait for green CI, then approve production deployment in ShipBrain.");
  }

  await octokit.git.createRef({
    owner: input.owner,
    repo: input.repo,
    ref: `refs/tags/${input.releaseTag}`,
    sha: pull.merge_commit_sha
  }).catch((error) => {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status === 422) {
      throw new Error(`Release tag ${input.releaseTag} already exists. Choose a new production release tag before approving deployment.`);
    }
    throw error;
  });

  return {
    merged: true,
    sha: pull.merge_commit_sha,
    releaseTag: input.releaseTag,
    releaseUrl: `https://github.com/${input.owner}/${input.repo}/releases/tag/${input.releaseTag}`,
    baseBranch: pull.base.ref
  };
}

export type ReleasePrInput = {
  owner: string;
  repo: string;
  head: string;
  base: string;
  releaseTag: string;
  body: string;
  token?: string;
};

const releaseFallbackFiles = ["index.html", "api/release.js", "api/trigger-incident.js", "server.mjs"];

function replaceReleaseFallback(content: string, releaseTag: string) {
  return content.replace(/cart-v\d{4}\.\d{2}\.\d{2}(?:[-\w.]*)?|cart-local-dev/g, releaseTag);
}

export async function createReleasePullRequest(input: ReleasePrInput) {
  const octokit = getOctokit(input.token);
  const { data: headRef } = await octokit.git.getRef({
    owner: input.owner,
    repo: input.repo,
    ref: `heads/${input.head}`
  });
  const headShaBeforePatch = headRef.object.sha;

  const { data: baseCommit } = await octokit.git.getCommit({
    owner: input.owner,
    repo: input.repo,
    commit_sha: headShaBeforePatch
  });

  const tree = (
    await Promise.all(
      releaseFallbackFiles.map(async (path) => {
        try {
          const { data: file } = await octokit.repos.getContent({
            owner: input.owner,
            repo: input.repo,
            path,
            ref: input.head
          });

          if (Array.isArray(file) || file.type !== "file" || !("content" in file)) return null;
          const currentContent = Buffer.from(file.content, "base64").toString("utf8");
          const nextContent = replaceReleaseFallback(currentContent, input.releaseTag);
          if (nextContent === currentContent) return null;

          const { data: blob } = await octokit.git.createBlob({
            owner: input.owner,
            repo: input.repo,
            content: Buffer.from(nextContent).toString("base64"),
            encoding: "base64"
          });

          return {
            path,
            mode: "100644" as const,
            type: "blob" as const,
            sha: blob.sha
          };
        } catch {
          return null;
        }
      })
    )
  ).filter((item): item is { path: string; mode: "100644"; type: "blob"; sha: string } => Boolean(item));

  // Track the latest HEAD sha after any commits we make
  let currentHeadSha = headShaBeforePatch;

  if (tree.length) {
    const { data: newTree } = await octokit.git.createTree({
      owner: input.owner,
      repo: input.repo,
      base_tree: baseCommit.tree.sha,
      tree
    });
    const { data: releaseCommit } = await octokit.git.createCommit({
      owner: input.owner,
      repo: input.repo,
      message: `chore: stamp release ${input.releaseTag}`,
      tree: newTree.sha,
      parents: [headShaBeforePatch]
    });
    await octokit.git.updateRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${input.head}`,
      sha: releaseCommit.sha,
      force: false
    });
    currentHeadSha = releaseCommit.sha;
  }

  // Guard: if head and base are still at the same SHA, GitHub will reject the PR
  // with "No commits between <base> and <head>". Create a lightweight release-stamp
  // commit on head so there is always at least one diff.
  try {
    const { data: baseRef } = await octokit.git.getRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${input.base}`
    });

    if (baseRef.object.sha === currentHeadSha) {
      const { data: headCommitForStamp } = await octokit.git.getCommit({
        owner: input.owner,
        repo: input.repo,
        commit_sha: currentHeadSha
      });
      const { data: stampCommit } = await octokit.git.createCommit({
        owner: input.owner,
        repo: input.repo,
        message: `chore: release stamp ${input.releaseTag}`,
        tree: headCommitForStamp.tree.sha,
        parents: [currentHeadSha]
      });
      await octokit.git.updateRef({
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.head}`,
        sha: stampCommit.sha,
        force: false
      });
    }
  } catch {
    // If stamp fails, proceed and let GitHub surface the error naturally
  }

  const head = `${input.owner}:${input.head}`;
  const { data: existing } = await octokit.pulls.list({
    owner: input.owner,
    repo: input.repo,
    state: "open",
    head,
    base: input.base,
    per_page: 1
  });

  const pr = existing[0] ?? (await octokit.pulls.create({
    owner: input.owner,
    repo: input.repo,
    title: `release: ${input.releaseTag}`,
    body: input.body,
    head: input.head,
    base: input.base
  })).data;

  return {
    number: pr.number,
    html_url: pr.html_url,
    state: pr.state,
    head: input.head,
    base: input.base
  };
}

export type ReverseSyncPrInput = {
  owner: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  incidentId: string;
  incidentTitle: string;
  hotfixPrNumber: number;
  releaseTag?: string;
  token?: string;
};

export async function createReverseSyncPR(input: ReverseSyncPrInput) {
  if (!input.token && !process.env.GITHUB_TEST_TOKEN) {
    return {
      number: 100,
      html_url: `https://github.com/${input.owner}/${input.repo}/pull/100`,
      state: "open",
      created: true
    };
  }

  const octokit = getOctokit(input.token);
  const head = `${input.owner}:${input.sourceBranch}`;

  // Check for existing open PR from source to target
  const { data: existing } = await octokit.pulls.list({
    owner: input.owner,
    repo: input.repo,
    state: "open",
    head,
    base: input.targetBranch,
    per_page: 1
  });

  if (existing.length > 0) {
    return {
      number: existing[0].number,
      html_url: existing[0].html_url,
      state: existing[0].state,
      created: false
    };
  }

  const prTitle = `sync: reverse merge hotfix from ${input.sourceBranch} to ${input.targetBranch}`;
  const prBody = [
    `## ShipBrain Reverse Sync PR`,
    ``,
    `This PR syncs the hotfix changes from \`${input.sourceBranch}\` back to \`${input.targetBranch}\` to keep branches in sync.`,
    ``,
    `### Context`,
    `- **Incident**: ${input.incidentTitle} (\`${input.incidentId.slice(0, 8)}\`)`,
    `- **Hotfix PR**: #${input.hotfixPrNumber}`,
    input.releaseTag ? `- **Release**: \`${input.releaseTag}\`` : "",
    ``,
    `### Why this PR exists`,
    `When a hotfix is merged directly to production (\`${input.sourceBranch}\`), those changes need to be synced back to the development branch (\`${input.targetBranch}\`) to prevent divergence and ensure the fix is included in future releases.`,
    ``,
    `### Action required`,
    `Review and merge this PR to complete the hotfix sync cycle. If there are conflicts, resolve them to ensure both branches contain the fix.`,
    ``,
    `---`,
    `*Automatically created by ShipBrain Incident Commander*`
  ].filter(Boolean).join("\n");

  const { data: pr } = await octokit.pulls.create({
    owner: input.owner,
    repo: input.repo,
    title: prTitle,
    body: prBody,
    head: input.sourceBranch,
    base: input.targetBranch
  });

  return {
    number: pr.number,
    html_url: pr.html_url,
    state: pr.state,
    created: true
  };
}

export type TagCommitInput = {
  owner: string;
  repo: string;
  sha: string;
  releaseTag: string;
  token?: string;
};

export async function ensureReleaseTagAvailable(input: TagCommitInput) {
  const octokit = getOctokit(input.token);
  try {
    await octokit.git.getRef({
      owner: input.owner,
      repo: input.repo,
      ref: `tags/${input.releaseTag}`
    });
    throw new Error(`Release tag ${input.releaseTag} already exists. Choose a unique release tag before approving deployment.`);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status === 404) return;
    throw error;
  }
}

export async function tagCommitForRelease(input: TagCommitInput) {
  const octokit = getOctokit(input.token);
  await octokit.git.createRef({
    owner: input.owner,
    repo: input.repo,
    ref: `refs/tags/${input.releaseTag}`,
    sha: input.sha
  }).catch((error) => {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status === 422) {
      throw new Error(`Release tag ${input.releaseTag} already exists.`);
    }
    throw error;
  });

  return {
    sha: input.sha,
    releaseTag: input.releaseTag,
    releaseUrl: `https://github.com/${input.owner}/${input.repo}/releases/tag/${input.releaseTag}`
  };
}
