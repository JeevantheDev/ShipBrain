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
      inputs.reverse_sync = input.reverseSync !== false ? "true" : "false";
    }

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
      const message = typeof error === "object" && error && "message" in error ? (error as { message?: string }).message : "";

      // If workflow not found (404) or doesn't have dispatch trigger, try next candidate
      if ((status === 404 || message?.includes("does not have")) && workflowCandidates.indexOf(workflowId) < workflowCandidates.length - 1) {
        continue;
      }
      throw error;
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

  for (const workflowId of workflowCandidates) {
    try {
      const dispatchRef = ref;

      // Different inputs for new vs old workflow
      const inputs = workflowId === "shipbrain-preview.yml"
        ? {
            branch: ref,
            source_pr_number: input.sourcePrNumber ? String(input.sourcePrNumber) : ""
          }
        : {
            force_fail: "false",
            deploy_preview: "true",
            source_pr_number: input.sourcePrNumber ? String(input.sourcePrNumber) : ""
          };

      await octokit.actions.createWorkflowDispatch({
        owner: input.owner,
        repo: input.repo,
        workflow_id: workflowId,
        ref: dispatchRef,
        inputs
      });
      usedWorkflowId = workflowId;
      break;
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
      const message = typeof error === "object" && error && "message" in error ? (error as { message?: string }).message : "";
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
  await octokit.git.createRef({
    owner: input.owner,
    repo: input.repo,
    ref: `refs/tags/${input.tag}`,
    sha: tagObject.sha
  });

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
