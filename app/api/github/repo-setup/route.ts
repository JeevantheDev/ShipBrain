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
  return { supabase, user, token: profile?.github_access_token ?? session?.provider_token ?? null };
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
  const buildOutputDir = String(body.buildOutputDir ?? "dist").trim() || "dist";
  const buildCommand = String(body.buildCommand ?? "npm run build").trim() || "npm run build";
  const customProdBranch = String(body.productionBranch ?? "").trim();
  const customDevBranch = String(body.developmentBranch ?? "").trim();
  const userEnvVars = (body.envVars ?? {}) as Record<string, string>;

  // Scan repository first
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
    buildCommand
  });
  await emit?.({ type: "step", label: "Preparing workflow files", status: "done", files: Object.keys(files) });

  // Flow: Commit workflows to develop branch first, then open PR to main
  // This ensures both branches start with the same workflow files after PR merge
  let workflowsCommittedToDevelop = false;
  let pr: Awaited<ReturnType<typeof openSetupPullRequest>> | null = null;

  if (Object.keys(files).length) {
    // Step 1: Commit workflows to develop branch first (if develop branch exists)
    const targetBranch = devBranch || prodBranch;
    await emit?.({ type: "step", label: `Adding workflows to ${targetBranch}`, status: "running" });
    try {
      await commitWorkflowsToDefaultBranch({ repoFullName, base: targetBranch, files, token });
      workflowsCommittedToDevelop = true;
      await emit?.({ type: "step", label: `Adding workflows to ${targetBranch}`, status: "done" });
    } catch (err: any) {
      await emit?.({ type: "step", label: `Adding workflows to ${targetBranch}`, status: "error", detail: err.message });
      console.warn(`Could not commit workflow files to ${targetBranch}:`, err.message);
    }

    // Step 2: Open PR from develop → main (if develop branch exists and is different from prod)
    // This ensures main branch gets the same workflow files when PR is merged
    if (devBranch && devBranch !== prodBranch && workflowsCommittedToDevelop) {
      await emit?.({ type: "step", label: `Opening PR: ${devBranch} → ${prodBranch}`, status: "running" });
      try {
        pr = await openSetupPullRequest({ repoFullName, base: prodBranch, head: devBranch, files, token });
        await emit?.({ type: "step", label: `Opening PR: ${devBranch} → ${prodBranch}`, status: "done", prUrl: pr.html_url });
      } catch (err: any) {
        await emit?.({ type: "step", label: `Opening PR: ${devBranch} → ${prodBranch}`, status: "error", detail: err.message });
        console.warn(`Could not open setup PR:`, err.message);
      }
    } else if (!devBranch || devBranch === prodBranch) {
      // If no develop branch, workflows are committed directly to prod
      await emit?.({ type: "step", label: "Workflows added to main branch", status: "done" });
    }
  } else {
    await emit?.({ type: "step", label: "Workflow files already configured", status: "done" });
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
