import { getOctokit } from "@/lib/github/client";

export type DispatchCloudflareDeployInput = {
  owner: string;
  repo: string;
  releaseTag: string;
  releaseSha: string;
  isHotfix?: boolean;
  reverseSync?: boolean;
  workflowId?: string;
  token?: string;
};

export async function dispatchCloudflareProductionDeploy(input: DispatchCloudflareDeployInput) {
  // Try new workflow name first, fall back to old names for backwards compatibility
  const workflowCandidates = input.workflowId
    ? [input.workflowId]
    : ["shipbrain-production.yml", "shipbrain-deploy.yml"];

  const octokit = getOctokit(input.token);
  let usedWorkflowId = workflowCandidates[0];
  let lastError: Error | null = null;

  for (const workflowId of workflowCandidates) {
    // Build inputs based on workflow type
    // Old workflows only support release_tag and release_sha
    // New workflow also supports is_hotfix and reverse_sync
    const isNewWorkflow = workflowId === "shipbrain-production.yml";
    const inputs: Record<string, string> = {
      release_tag: input.releaseTag,
      release_sha: input.releaseSha
    };

    // Only add optional inputs for the new workflow
    if (isNewWorkflow) {
      inputs.is_hotfix = input.isHotfix ? "true" : "false";
      // Note: reverse_sync input was removed from the workflow.
      // Reverse sync PRs are now created by ShipBrain backend using user's GitHub token.
    }

    // We try to dispatch, retrying on 422 "No ref found" propagation delays
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Use the release tag as ref so the workflow run is linked to the spec via release_tag
        const dispatchRef = isNewWorkflow ? input.releaseTag : "main";
        await octokit.actions.createWorkflowDispatch({
          owner: input.owner,
          repo: input.repo,
          workflow_id: workflowId,
          ref: dispatchRef,
          inputs
        });
        usedWorkflowId = workflowId;
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
        const message = (typeof error === "object" && error && "message" in error ? (error as { message?: string }).message : "") || "";

        if (status === 422 && message.includes("No ref found") && attempt < maxRetries - 1) {
          attempt++;
          console.warn(`[dispatch] Ref ${input.releaseTag} not found by GitHub Actions yet. Retrying in 2 seconds (attempt ${attempt}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        // If workflow not found (404) or doesn't have dispatch trigger, try next candidate
        if ((status === 404 || message?.includes("does not have")) && workflowCandidates.indexOf(workflowId) < workflowCandidates.length - 1) {
          break; // break retry loop to try next candidate in outer loop
        }
        throw error;
      }
    }

    if (!lastError) {
      break;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return {
    workflowId: usedWorkflowId,
    workflowUrl: `https://github.com/${input.owner}/${input.repo}/actions/workflows/${usedWorkflowId}`,
    releaseTag: input.releaseTag,
    releaseSha: input.releaseSha,
    isHotfix: input.isHotfix ?? false
  };
}

export type DispatchDevelopPreviewInput = {
  owner: string;
  repo: string;
  ref?: string;
  defaultBranch?: string;
  sourcePrNumber?: number | null;
  workflowId?: string;
  token?: string;
  /** If true, don't fall back to default branch - fail if target branch workflow not found */
  noFallback?: boolean;
};

export async function dispatchDevelopPreviewDeploy(input: DispatchDevelopPreviewInput) {
  // Try new dedicated preview workflow first, fall back to old CI workflow
  const workflowCandidates = input.workflowId
    ? [input.workflowId]
    : ["shipbrain-preview.yml", "shipbrain-ci.yml"];

  const ref = input.ref ?? "develop";
  const defaultBranch = input.defaultBranch || "main";
  const octokit = getOctokit(input.token);
  let usedWorkflowId = workflowCandidates[0];
  let actualDispatchRef = ref;

  for (const workflowId of workflowCandidates) {
    // Different inputs for new vs old workflow
    // Always pass the target branch in inputs so workflow can checkout correct branch
    const inputs = workflowId === "shipbrain-preview.yml"
      ? {
          branch: ref,
          source_pr_number: input.sourcePrNumber ? String(input.sourcePrNumber) : ""
        }
      : {
          force_fail: "false",
          deploy_preview: "true",
          deploy_branch: ref, // Added: ensure the workflow knows which branch to deploy
          source_pr_number: input.sourcePrNumber ? String(input.sourcePrNumber) : ""
        };

    try {
      // Try dispatching on the specific target ref first so the checkout step uses the correct branch
      await octokit.actions.createWorkflowDispatch({
        owner: input.owner,
        repo: input.repo,
        workflow_id: workflowId,
        ref: ref,
        inputs
      });
      usedWorkflowId = workflowId;
      actualDispatchRef = ref;
      break;
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
      const message = typeof error === "object" && error && "message" in error ? (error as { message?: string }).message : "";

      // If the target branch ref does not exist on GitHub, try to create it from the default branch
      if ((status === 404 || status === 422) && ref !== defaultBranch) {
        try {
          // Check if the branch exists
          await octokit.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${ref}` });
        } catch (refError: any) {
          if (refError.status === 404) {
            console.log(`Branch ${ref} does not exist on GitHub. Attempting to create it from ${defaultBranch}...`);
            try {
              const { data: defaultRef } = await octokit.git.getRef({
                owner: input.owner,
                repo: input.repo,
                ref: `heads/${defaultBranch}`
              });
              await octokit.git.createRef({
                owner: input.owner,
                repo: input.repo,
                ref: `refs/heads/${ref}`,
                sha: defaultRef.object.sha
              });
              console.log(`Successfully created missing branch ${ref} from ${defaultBranch}`);

              // Retry dispatch on the newly created branch
              await octokit.actions.createWorkflowDispatch({
                owner: input.owner,
                repo: input.repo,
                workflow_id: workflowId,
                ref: ref,
                inputs
              });
              usedWorkflowId = workflowId;
              actualDispatchRef = ref;
              break; // Success! Break out of candidates loop
            } catch (createOrDispatchError) {
              console.error(`Failed to create missing branch ${ref} or retry dispatch:`, createOrDispatchError);
            }
          }
        }
      }

      // If dispatch on target ref fails (e.g. branch or workflow not found on that branch),
      // try falling back to the default branch (unless noFallback is set).
      if ((status === 404 || status === 422) && !input.noFallback) {
        try {
          // When falling back to default branch, still pass the correct target branch in inputs
          await octokit.actions.createWorkflowDispatch({
            owner: input.owner,
            repo: input.repo,
            workflow_id: workflowId,
            ref: defaultBranch,
            inputs // inputs still contain the correct target branch
          });
          usedWorkflowId = workflowId;
          actualDispatchRef = defaultBranch;
          console.warn(`Preview deploy: workflow dispatched from ${defaultBranch} but targeting ${ref}`);
          break;
        } catch (fallbackError) {
          // If fallback fails as well, and there are more candidates, continue. Otherwise throw.
          if (workflowCandidates.indexOf(workflowId) < workflowCandidates.length - 1) {
            continue;
          }
          throw fallbackError;
        }
      }

      // If workflow not found (404) or doesn't have dispatch trigger (422), try next candidate
      if ((status === 404 || status === 422 || message?.includes("does not have")) && workflowCandidates.indexOf(workflowId) < workflowCandidates.length - 1) {
        continue;
      }
      throw error;
    }
  }

  return {
    workflowId: usedWorkflowId,
    workflowUrl: `https://github.com/${input.owner}/${input.repo}/actions/workflows/${usedWorkflowId}`,
    ref,
    actualDispatchRef, // Added: indicates which branch the workflow was actually dispatched from
    sourcePrNumber: input.sourcePrNumber ?? null
  };
}

export type CreateReleaseTagInput = {
  owner: string;
  repo: string;
  tag: string;
  sha: string;
  message?: string;
  token?: string;
};

export async function createReleaseTag(input: CreateReleaseTagInput) {
  const octokit = getOctokit(input.token);

  // Create an annotated tag object
  const { data: tagObject } = await octokit.git.createTag({
    owner: input.owner,
    repo: input.repo,
    tag: input.tag,
    message: input.message || `Release ${input.tag}`,
    object: input.sha,
    type: "commit"
  });

  // Create the tag reference
  try {
    await octokit.git.createRef({
      owner: input.owner,
      repo: input.repo,
      ref: `refs/tags/${input.tag}`,
      sha: tagObject.sha
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status === 422) {
      // Force update the tag reference if it already exists
      await octokit.git.updateRef({
        owner: input.owner,
        repo: input.repo,
        ref: `tags/${input.tag}`,
        sha: tagObject.sha,
        force: true
      });
    } else {
      throw error;
    }
  }

  return {
    tag: input.tag,
    sha: input.sha,
    tagSha: tagObject.sha,
    tagUrl: `https://github.com/${input.owner}/${input.repo}/releases/tag/${input.tag}`
  };
}

export type DispatchHotfixDeployInput = {
  owner: string;
  repo: string;
  releaseTag: string;
  releaseSha: string;
  reverseSync?: boolean;
  token?: string;
};

export async function dispatchHotfixDeploy(input: DispatchHotfixDeployInput) {
  // Hotfix deployments use the same production workflow with is_hotfix=true
  return dispatchCloudflareProductionDeploy({
    ...input,
    isHotfix: true,
    reverseSync: input.reverseSync !== false
  });
}

// Legacy export for backwards compatibility
export const dispatchVercelProductionDeploy = dispatchCloudflareProductionDeploy;
export type DispatchVercelDeployInput = DispatchCloudflareDeployInput;
