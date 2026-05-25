/**
 * Vercel API client for fetching deployment information
 */

export type VercelDeployment = {
  uid: string;
  url: string;
  state: "BUILDING" | "ERROR" | "INITIALIZING" | "QUEUED" | "READY" | "CANCELED";
  target: "production" | "preview" | null;
  createdAt: number;
  buildingAt?: number;
  ready?: number;
  meta?: {
    gitBranch?: string;
    gitCommitSha?: string;
    gitCommitMessage?: string;
  };
  inspectorUrl?: string;
};

export type VercelDeploymentsResponse = {
  deployments: VercelDeployment[];
};

/**
 * Fetch recent deployments from Vercel API
 */
export async function getVercelDeployments(options: {
  vercelToken: string;
  projectId: string;
  target?: "production" | "preview";
  limit?: number;
}): Promise<VercelDeployment[]> {
  const { vercelToken, projectId, target, limit = 10 } = options;

  const params = new URLSearchParams({
    projectId,
    limit: String(limit),
  });

  if (target) {
    params.set("target", target);
  }

  const response = await fetch(`https://api.vercel.com/v6/deployments?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${vercelToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vercel API error: ${response.status} ${text}`);
  }

  const data: VercelDeploymentsResponse = await response.json();
  return data.deployments ?? [];
}

/**
 * Find a deployment by branch name
 */
export function findDeploymentByBranch(
  deployments: VercelDeployment[],
  branch: string,
  target?: "production" | "preview"
): VercelDeployment | undefined {
  return deployments.find((d) => {
    const matchesBranch = d.meta?.gitBranch === branch;
    const matchesTarget = !target || d.target === target;
    return matchesBranch && matchesTarget && d.state === "READY";
  });
}

/**
 * Find a deployment by commit SHA
 */
export function findDeploymentBySha(
  deployments: VercelDeployment[],
  sha: string,
  target?: "production" | "preview"
): VercelDeployment | undefined {
  return deployments.find((d) => {
    const matchesSha = d.meta?.gitCommitSha === sha || d.meta?.gitCommitSha?.startsWith(sha);
    const matchesTarget = !target || d.target === target;
    return matchesSha && matchesTarget && d.state === "READY";
  });
}

/**
 * Get the full deployment URL (with https://)
 */
export function getDeploymentUrl(deployment: VercelDeployment): string {
  return `https://${deployment.url}`;
}

/**
 * Get the latest production deployment URL for a project
 */
export async function getLatestProductionUrl(options: {
  vercelToken: string;
  projectId: string;
}): Promise<string | null> {
  const deployments = await getVercelDeployments({
    ...options,
    target: "production",
    limit: 5,
  });

  const ready = deployments.find((d) => d.state === "READY");
  return ready ? getDeploymentUrl(ready) : null;
}

/**
 * Get the latest preview deployment URL for a branch
 */
export async function getLatestPreviewUrl(options: {
  vercelToken: string;
  projectId: string;
  branch: string;
}): Promise<string | null> {
  const deployments = await getVercelDeployments({
    ...options,
    target: "preview",
    limit: 10,
  });

  const ready = findDeploymentByBranch(deployments, options.branch, "preview");
  return ready ? getDeploymentUrl(ready) : null;
}
