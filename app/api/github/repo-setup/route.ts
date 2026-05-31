import { NextResponse } from "next/server";
import {
  openSetupPullRequest,
  putActionsSecret,
  scanRepository,
  workflowFiles,
  commitWorkflowsToDefaultBranch,
  deleteExistingSetupBranchesAndPRs
} from "@/lib/github/setup";
import {
  ensureCloudflareProject,
  generateProjectName,
  getShipBrainCloudflareCredentials
} from "@/lib/cloudflare/client";
import { generateShipBrainApiKey, hashShipBrainApiKey, lastFour } from "@/lib/shipbrain/api-keys";
import { resolvePublicShipBrainUrl } from "@/lib/shipbrain/public-url";
import { requirePasswordConfirmation } from "@/lib/auth/reauth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type SetupEmit = (event: Record<string, unknown>) => void | Promise<void>;

async function getContext() {
  const supabase = getSupabaseServerClient();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const user = session?.user ?? null;
  if (!user) return { supabase, user: null, token: null };
  const { data: profile } = await supabase
    .from("profiles")
    .select("github_access_token")
    .eq("id", user.id)
    .maybeSingle();
  const token = profile?.github_access_token ?? null;
  return { supabase, user, token };
}

export async function POST(request: Request) {
  const { supabase, user, token } = await getContext();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!token) return NextResponse.json({ error: "GitHub is not connected.", requiresGithub: true }, { status: 409 });

  const body = await request.json();
  try {
    await requirePasswordConfirmation(user, body.reauthPassword);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Password confirmation failed." }, { status: 401 });
  }
  if (body?.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit: SetupEmit = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        try {
          const result = await runSetup({ request, supabase, user, token, body, emit });
          await emit({ type: "complete", data: result });
        } catch (error) {
          await emit({
            type: "error",
            error: "ShipBrain could not complete repo setup.",
            detail: error instanceof Error ? error.message : "GitHub secret injection or setup PR creation failed."
          });
        } finally {
          controller.close();
        }
      }
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  try {
    const result = await runSetup({ request, supabase, user, token, body });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: "ShipBrain could not complete repo setup.",
        detail: error instanceof Error ? error.message : "GitHub secret injection or setup PR creation failed."
      },
      { status: 500 }
    );
  }
}

async function runSetup({
  request,
  supabase,
  user,
  token,
  body,
  emit
}: {
  request: Request;
  supabase: ReturnType<typeof getSupabaseServerClient>;
  user: { id: string };
  token: string;
  body: any;
  emit?: SetupEmit;
}) {
  const repo = body.repo as { id?: number; full_name?: string; default_branch?: string };
  const repoFullName = String(repo?.full_name ?? body.repoFullName ?? "");
  if (!repoFullName.includes("/")) throw new Error("Select a valid GitHub repository.");

  const skipIncidents = Boolean(body.skipIncidents);
  const enableTelegram = Boolean(body.enableTelegram);
  const forceOverwrite = Boolean(body.forceOverwrite); // Re-onboarding: overwrite existing workflow files
  const buildOutputDir = String(body.buildOutputDir ?? "dist").trim() || "dist";
  const buildCommand = String(body.buildCommand ?? "npm run build").trim() || "npm run build";
  const customProdBranch = String(body.productionBranch ?? "").trim();
  const customDevBranch = String(body.developmentBranch ?? "").trim();
  const userEnvVars = (body.envVars ?? {}) as Record<string, string>;

  // Verify write access to repository first
  await emit?.({ type: "step", label: "Verifying repository access", status: "running" });
  try {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: token });
    const [owner, repoName] = repoFullName.split("/");
    const { data: repoData } = await octokit.repos.get({ owner, repo: repoName });

    if (!repoData.permissions?.push && !repoData.permissions?.admin) {
      throw new Error(
        `You don't have write access to ${repoFullName}. ` +
        `Please either onboard a repository you own, or ask the repo owner to add you as a collaborator with write access.`
      );
    }
    await emit?.({ type: "step", label: "Verifying repository access", status: "done" });
  } catch (error: any) {
    if (error.status === 404) {
      throw new Error(`Repository ${repoFullName} not found. Make sure it exists and your GitHub account has access to it.`);
    }
    if (error.message?.includes("write access")) {
      throw error;
    }
    throw new Error(`Could not verify access to ${repoFullName}: ${error.message}`);
  }

  // Scan repository
  await emit?.({ type: "step", label: "Scanning repository", status: "running" });
  const scan = await scanRepository(repoFullName, token);
  await emit?.({ type: "step", label: "Scanning repository", status: "done" });

  if (scan.branches.scenario === "custom_required" && !customProdBranch) {
    throw new Error("Production branch is required because ShipBrain could not detect main, master, or develop.");
  }

  const prodBranch = customProdBranch || scan.branches.productionBranch || repo.default_branch || "main";
  const devBranch = customDevBranch || scan.branches.developmentBranch;

  // Generate ShipBrain credentials
  const shipbrainApiKey = generateShipBrainApiKey();
  const apiUrl = resolvePublicShipBrainUrl(request, { requirePublicForLocal: true });

  // Get ShipBrain's Cloudflare credentials
  const { apiToken: cfApiToken, accountId: cfAccountId } = getShipBrainCloudflareCredentials();

  // Create Cloudflare Pages project automatically
  await emit?.({ type: "step", label: "Creating Cloudflare Pages project", status: "running" });

  let cloudflareProjectName: string;
  let cloudflareProjectUrl: string;

  try {
    // Create or get the Cloudflare Pages project
    const cfResult = await ensureCloudflareProject({
      repoFullName,
      productionBranch: prodBranch,
      envVars: {
        ...userEnvVars,
        SHIPBRAIN_API_KEY: shipbrainApiKey,
        SHIPBRAIN_API_URL: apiUrl
      }
    });

    if (!cfResult.success) {
      throw new Error(cfResult.error || "Failed to create Cloudflare Pages project");
    }

    cloudflareProjectName = cfResult.projectName;
    cloudflareProjectUrl = cfResult.projectUrl;

    await emit?.({ type: "step", label: "Creating Cloudflare Pages project", status: "done", detail: cloudflareProjectUrl });
  } catch (error) {
    throw new Error(`Cloudflare setup failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Inject GitHub Actions secrets
  const secretSteps: string[] = [];
  const secrets: Array<[string, string]> = [
    ["CLOUDFLARE_API_TOKEN", cfApiToken],
    ["CLOUDFLARE_ACCOUNT_ID", cfAccountId],
    ["CF_PROJECT_NAME", cloudflareProjectName],
    ["SHIPBRAIN_API_KEY", shipbrainApiKey],
    ["SHIPBRAIN_API_URL", apiUrl]
  ];

  for (const [name, value] of secrets) {
    await emit?.({ type: "step", label: `Injecting ${name}`, status: "running" });
    await putActionsSecret(repoFullName, name, value, token);
    secretSteps.push(name);
    await emit?.({ type: "step", label: `Injecting ${name}`, status: "done" });
  }

  // Clean up any existing setup branches/PRs to start fresh
  await emit?.({ type: "step", label: "Cleaning up existing setup branches", status: "running" });
  const deleted = await deleteExistingSetupBranchesAndPRs(repoFullName, token);
  if (deleted.branches.length || deleted.prs.length) {
    await emit?.({ type: "step", label: "Cleaning up existing setup branches", status: "done", detail: `Deleted ${deleted.branches.length} branches, ${deleted.prs.length} PRs` });
  } else {
    await emit?.({ type: "step", label: "Cleaning up existing setup branches", status: "done", detail: "No existing setup found" });
  }

  // Prepare workflow files
  await emit?.({ type: "step", label: "Preparing workflow files", status: "running" });
  const files = workflowFiles({
    devBranch,
    prodBranch,
    includeCloudflare: true,
    includeIncidents: !skipIncidents,
    ciExists: scan.workflows.ci,
    previewExists: scan.workflows.preview,
    productionExists: scan.workflows.production,
    notifyExists: scan.workflows.notify,
    deployExists: scan.workflows.deploy,
    incidentsExists: scan.workflows.incidents,
    packageJson: scan.project.packageJson,
    buildOutputDir,
    buildCommand,
    forceOverwrite
  });
  await emit?.({ type: "step", label: "Preparing workflow files", status: "done", files: Object.keys(files) });

  // Flow: Always create a fresh setup branch with workflow files, then open PR to main
  // This ensures the PR can always be created even if workflows already exist on branches
  let pr: Awaited<ReturnType<typeof openSetupPullRequest>> | null = null;

  if (Object.keys(files).length) {
    // Step 1: Create setup PR with workflow files (always creates a fresh branch)
    await emit?.({ type: "step", label: `Opening setup PR → ${prodBranch}`, status: "running" });
    // Don't pass head - this creates a fresh shipbrain/setup-xxx branch with the files
    pr = await openSetupPullRequest({ repoFullName, base: prodBranch, files, token });
    await emit?.({ type: "step", label: `Opening setup PR → ${prodBranch}`, status: "done", prUrl: pr.html_url });

    // Step 2: Also commit workflows to develop branch if it exists (so both branches have them)
    if (devBranch && devBranch !== prodBranch) {
      await emit?.({ type: "step", label: `Adding workflows to ${devBranch}`, status: "running" });
      try {
        await commitWorkflowsToDefaultBranch({ repoFullName, base: devBranch, files, token });
        await emit?.({ type: "step", label: `Adding workflows to ${devBranch}`, status: "done" });
      } catch (err: any) {
        // Non-fatal: develop commit can fail but PR to main is what matters
        await emit?.({ type: "step", label: `Adding workflows to ${devBranch}`, status: "error", detail: err.message });
        console.warn(`Could not commit workflow files to ${devBranch}:`, err.message);
      }
    }
  } else {
    // This should not happen with forceOverwrite: true, but handle it as an error
    throw new Error("No workflow files were generated. Please try again or contact support.");
  }

  // Save repo record to database
  await emit?.({ type: "step", label: "Saving ShipBrain repo record", status: "running" });
  await supabase.from("profiles").upsert({ id: user.id });

  const { data: savedRepo, error } = await supabase
    .from("repos")
    .upsert(
      {
        user_id: user.id,
        github_repo_id: repo.id ?? 0,
        full_name: repoFullName,
        default_branch: repo.default_branch ?? prodBranch,
        setup_status: pr ? "pr_opened" : "already_configured",
        setup_pr_number: pr?.number ?? null,
        setup_pr_url: pr?.html_url ?? null,
        setup_branch: pr?.branch ?? null,
        shipbrain_api_key_hash: hashShipBrainApiKey(shipbrainApiKey),
        shipbrain_api_key_last4: lastFour(shipbrainApiKey),
        connected_at: new Date().toISOString(),
        setup_metadata: {
          scan,
          prodBranch,
          devBranch,
          skipIncidents,
          enableTelegram,
          injectedSecrets: secretSteps,
          filesAdded: Object.keys(files),
          apiUrl,
          buildOutputDir,
          buildCommand,
          cloudflareProjectName,
          cloudflareProjectUrl,
          cloudflareAccountId: cfAccountId
        },
        telegram_notifications_enabled: enableTelegram
      },
      { onConflict: "user_id,full_name" }
    )
    .select("id, full_name, setup_status, setup_pr_number, setup_pr_url, setup_metadata")
    .single();

  if (error) {
    throw new Error(`Setup completed in GitHub, but ShipBrain could not save the repo record. ${error.message}`);
  }
  await emit?.({ type: "step", label: "Saving ShipBrain repo record", status: "done" });

  return {
    ok: true,
    repo: savedRepo,
    repoFullName,
    scan,
    pr,
    injectedSecrets: secretSteps,
    filesAdded: Object.keys(files),
    shipbrainApiKey,
    cloudflareProjectName,
    cloudflareProjectUrl
  };
}
