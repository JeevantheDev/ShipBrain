/**
 * Cloudflare Pages API client for fetching deployment information
 * ShipBrain manages all Cloudflare infrastructure - users don't need Cloudflare accounts
 */

export type CloudflareDeployment = {
  id: string;
  url: string;
  environment: "production" | "preview";
  deployment_trigger: {
    type: string;
    metadata: {
      branch?: string;
      commit_hash?: string;
      commit_message?: string;
    };
  };
  latest_stage: {
    name: string;
    status: "active" | "idle" | "success" | "failure" | "canceled";
    ended_on?: string;
  };
  created_on: string;
  modified_on: string;
  project_name: string;
};

export type CloudflareDeploymentsResponse = {
  result: CloudflareDeployment[];
  success: boolean;
  errors: any[];
  messages: any[];
};

export type CloudflareProject = {
  id: string;
  name: string;
  subdomain: string;
  domains: string[];
  production_branch: string;
  created_on: string;
  deployment_configs: {
    preview: { env_vars?: Record<string, { value: string; type?: string }> };
    production: { env_vars?: Record<string, { value: string; type?: string }> };
  };
};

/**
 * Get ShipBrain's Cloudflare credentials from environment
 * ShipBrain owns the Cloudflare account - users don't need to provide credentials
 */
export function getShipBrainCloudflareCredentials() {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!apiToken || !accountId) {
    throw new Error("ShipBrain Cloudflare credentials not configured. Contact support.");
  }

  return { apiToken, accountId };
}

/**
 * Generate a unique project name from repo full name
 * e.g., "user/my-app" -> "shipbrain-user-my-app"
 */
export function generateProjectName(repoFullName: string): string {
  const sanitized = repoFullName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `sb-${sanitized}`.slice(0, 58); // Cloudflare limit is 63 chars
}

/**
 * Create a new Cloudflare Pages project for a repo
 */
export async function createCloudflareProject(options: {
  apiToken: string;
  accountId: string;
  projectName: string;
  productionBranch?: string;
}): Promise<{ success: boolean; project?: CloudflareProject; projectUrl?: string; error?: string }> {
  const { apiToken, accountId, projectName, productionBranch = "main" } = options;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: projectName,
      production_branch: productionBranch,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    // Project might already exist - that's ok
    if (response.status === 409 || data.errors?.[0]?.code === 8000007) {
      // Get existing project
      const existing = await getCloudflareProject({ apiToken, accountId, projectName });
      if (existing.success) {
        return existing;
      }
    }
    return { success: false, error: data.errors?.[0]?.message || `Cloudflare API error: ${response.status}` };
  }

  if (!data.success) {
    return { success: false, error: data.errors?.[0]?.message || "Unknown error" };
  }

  const project = data.result as CloudflareProject;
  const subdomain = project.subdomain.endsWith(".pages.dev") ? project.subdomain : `${project.subdomain}.pages.dev`;
  const projectUrl = `https://${subdomain}`;

  return { success: true, project, projectUrl };
}

/**
 * Get an existing Cloudflare Pages project
 */
export async function getCloudflareProject(options: {
  apiToken: string;
  accountId: string;
  projectName: string;
}): Promise<{ success: boolean; project?: CloudflareProject; projectUrl?: string; error?: string }> {
  const { apiToken, accountId, projectName } = options;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return { success: false, error: "Project not found" };
    }
    return { success: false, error: `Cloudflare API error: ${response.status}` };
  }

  const data = await response.json();

  if (!data.success) {
    return { success: false, error: data.errors?.[0]?.message || "Unknown error" };
  }

  const project = data.result as CloudflareProject;
  const subdomain = project.subdomain.endsWith(".pages.dev") ? project.subdomain : `${project.subdomain}.pages.dev`;
  const projectUrl = `https://${subdomain}`;

  return { success: true, project, projectUrl };
}

/**
 * Set environment variables for a Cloudflare Pages project
 */
export async function setProjectEnvVars(options: {
  apiToken: string;
  accountId: string;
  projectName: string;
  envVars: Record<string, string>;
  environment: "preview" | "production" | "both";
}): Promise<{ success: boolean; error?: string }> {
  const { apiToken, accountId, projectName, envVars, environment } = options;

  // Convert env vars to Cloudflare format
  const formattedVars: Record<string, { value: string; type: string }> = {};
  for (const [key, value] of Object.entries(envVars)) {
    formattedVars[key] = { value, type: "plain_text" };
  }

  const deploymentConfigs: any = {};
  if (environment === "preview" || environment === "both") {
    deploymentConfigs.preview = { env_vars: formattedVars };
  }
  if (environment === "production" || environment === "both") {
    deploymentConfigs.production = { env_vars: formattedVars };
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deployment_configs: deploymentConfigs }),
  });

  if (!response.ok) {
    const data = await response.json();
    return { success: false, error: data.errors?.[0]?.message || `Cloudflare API error: ${response.status}` };
  }

  return { success: true };
}

/**
 * Ensure a Cloudflare Pages project exists for a repo (create if needed)
 */
export async function ensureCloudflareProject(options: {
  repoFullName: string;
  productionBranch?: string;
  envVars?: Record<string, string>;
}): Promise<{ success: boolean; projectName: string; projectUrl: string; error?: string }> {
  const { apiToken, accountId } = getShipBrainCloudflareCredentials();
  const projectName = generateProjectName(options.repoFullName);

  // Try to get existing project first
  let result = await getCloudflareProject({ apiToken, accountId, projectName });

  // Create if it doesn't exist
  if (!result.success) {
    result = await createCloudflareProject({
      apiToken,
      accountId,
      projectName,
      productionBranch: options.productionBranch,
    });
  }

  if (!result.success || !result.projectUrl) {
    return { success: false, projectName, projectUrl: "", error: result.error };
  }

  // Set environment variables if provided
  if (options.envVars && Object.keys(options.envVars).length > 0) {
    const envResult = await setProjectEnvVars({
      apiToken,
      accountId,
      projectName,
      envVars: options.envVars,
      environment: "both",
    });
    if (!envResult.success) {
      console.error("Warning: Failed to set env vars:", envResult.error);
    }
  }

  return { success: true, projectName, projectUrl: result.projectUrl };
}

/**
 * Fetch recent deployments from Cloudflare Pages API
 */
export async function getCloudflareDeployments(options: {
  apiToken: string;
  accountId: string;
  projectName: string;
  environment?: "production" | "preview";
  limit?: number;
}): Promise<CloudflareDeployment[]> {
  const { apiToken, accountId, projectName, environment, limit = 10 } = options;

  const params = new URLSearchParams();
  if (environment) {
    params.set("env", environment);
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloudflare API error: ${response.status} ${text}`);
  }

  const data: CloudflareDeploymentsResponse = await response.json();

  if (!data.success) {
    throw new Error(`Cloudflare API error: ${data.errors?.[0]?.message || "Unknown error"}`);
  }

  return (data.result ?? []).slice(0, limit);
}

/**
 * Find a deployment by branch name
 */
export function findDeploymentByBranch(
  deployments: CloudflareDeployment[],
  branch: string,
  environment?: "production" | "preview"
): CloudflareDeployment | undefined {
  return deployments.find((d) => {
    const matchesBranch = d.deployment_trigger?.metadata?.branch === branch;
    const matchesEnv = !environment || d.environment === environment;
    const isSuccess = d.latest_stage?.status === "success";
    return matchesBranch && matchesEnv && isSuccess;
  });
}

/**
 * Find a deployment by commit SHA
 */
export function findDeploymentBySha(
  deployments: CloudflareDeployment[],
  sha: string,
  environment?: "production" | "preview"
): CloudflareDeployment | undefined {
  return deployments.find((d) => {
    const commitHash = d.deployment_trigger?.metadata?.commit_hash;
    const matchesSha = commitHash === sha || commitHash?.startsWith(sha);
    const matchesEnv = !environment || d.environment === environment;
    const isSuccess = d.latest_stage?.status === "success";
    return matchesSha && matchesEnv && isSuccess;
  });
}

/**
 * Get the full deployment URL (already includes https://)
 */
export function getDeploymentUrl(deployment: CloudflareDeployment): string {
  if (deployment.url.startsWith("https://")) {
    return deployment.url;
  }
  return `https://${deployment.url}`;
}

/**
 * Get the latest production deployment URL for a project
 */
export async function getLatestProductionUrl(options: {
  apiToken: string;
  accountId: string;
  projectName: string;
}): Promise<string | null> {
  const deployments = await getCloudflareDeployments({
    ...options,
    environment: "production",
    limit: 5,
  });

  const ready = deployments.find((d) => d.latest_stage?.status === "success");
  return ready ? getDeploymentUrl(ready) : null;
}

/**
 * Get the latest preview deployment URL for a branch
 */
export async function getLatestPreviewUrl(options: {
  apiToken: string;
  accountId: string;
  projectName: string;
  branch: string;
}): Promise<string | null> {
  const deployments = await getCloudflareDeployments({
    ...options,
    environment: "preview",
    limit: 10,
  });

  const ready = findDeploymentByBranch(deployments, options.branch, "preview");
  return ready ? getDeploymentUrl(ready) : null;
}

/**
 * Get the preview deployment URL for a specific commit SHA
 */
export async function getPreviewUrlForSha(options: {
  apiToken: string;
  accountId: string;
  projectName: string;
  sha: string;
}): Promise<string | null> {
  const deployments = await getCloudflareDeployments({
    apiToken: options.apiToken,
    accountId: options.accountId,
    projectName: options.projectName,
    environment: "preview",
    limit: 20,
  });

  const ready = findDeploymentBySha(deployments, options.sha, "preview");
  return ready ? getDeploymentUrl(ready) : null;
}

/**
 * Verify Cloudflare API token by fetching user details
 */
export async function verifyCloudflareToken(apiToken: string): Promise<boolean> {
  const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    return false;
  }

  const data = await response.json();
  return data.success === true;
}

/**
 * Verify Cloudflare Pages project exists and is accessible
 */
export async function verifyCloudflareProject(options: {
  apiToken: string;
  accountId: string;
  projectName: string;
}): Promise<{ success: boolean; projectUrl?: string; error?: string }> {
  const result = await getCloudflareProject(options);
  return result;
}
