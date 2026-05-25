import { NextResponse } from "next/server";
import {
  openSetupPullRequest,
  putActionsSecret,
  scanRepository,
  workflowFiles
} from "@/lib/github/setup";
import { generateShipBrainApiKey, hashShipBrainApiKey, lastFour } from "@/lib/shipbrain/api-keys";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type SetupEmit = (event: Record<string, unknown>) => void | Promise<void>;

function publicShipBrainApiUrl(request: Request) {
  const configured =
    process.env.SHIPBRAIN_API_URL ??
    process.env.NEXT_PUBLIC_SHIPBRAIN_API_URL ??
    process.env.NGROK_PUBLIC_URL ??
    process.env.NGROK_URL;
  if (configured?.trim()) return configured.trim().replace(/\/$/, "");

  const origin = new URL(request.url).origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) {
    throw new Error("Set SHIPBRAIN_API_URL to your public ngrok URL before connecting a repo from localhost. GitHub Actions cannot call localhost.");
  }
  return origin.replace(/\/$/, "");
}

function safeVercelSettingsUrl(value: string) {
  if (!value || value.includes("/dashboard/project/")) return null;
  return value;
}

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

async function verifyVercelProject(vercelToken: string, vercelOrgId: string, vercelProjectId: string) {
  const headers = { Authorization: `Bearer ${vercelToken}` };
  const scopedUrl = `https://api.vercel.com/v9/projects/${encodeURIComponent(vercelProjectId)}?teamId=${encodeURIComponent(vercelOrgId)}`;
  let response = await fetch(scopedUrl, { headers });
  if (response.status === 404) {
    response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(vercelProjectId)}`, { headers });
  }
  if (!response.ok) {
    throw new Error("Vercel could not verify the token, org ID, and project ID together.");
  }
  const project = await response.json().catch(() => null);
  const accountId = project?.accountId ?? project?.account?.id ?? project?.owner?.id ?? project?.ownerId ?? null;
  if (accountId && accountId !== vercelOrgId) {
    throw new Error("Vercel project does not belong to the provided org/account ID.");
  }
}

// verifyPagerDutyRoutingKey removed since we use ShipBrain incidents directly

export async function POST(request: Request) {
  const { supabase, user, token } = await getContext();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!token) return NextResponse.json({ error: "GitHub is not connected.", requiresGithub: true }, { status: 409 });

  const body = await request.json();
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

  const skipVercel = Boolean(body.skipVercel);
  const skipIncidents = Boolean(body.skipIncidents);
  const vercelToken = String(body.vercelToken ?? "").trim();
  const vercelOrgId = String(body.vercelOrgId ?? "").trim();
  const vercelProjectId = String(body.vercelProjectId ?? "").trim();
  const customProdBranch = String(body.productionBranch ?? "").trim();
  const customDevBranch = String(body.developmentBranch ?? "").trim();
  const providedVercelSettingsUrl = safeVercelSettingsUrl(String(body.vercelSettingsUrl ?? "").trim());

  if (!skipVercel && (!vercelToken || !vercelOrgId || !vercelProjectId)) {
    throw new Error("Vercel setup needs VERCEL_TOKEN, VERCEL_ORG_ID, and VERCEL_PROJECT_ID or use Skip Vercel setup.");
  }

  if (!skipVercel) {
    await emit?.({ type: "step", label: "Verifying Vercel project", status: "running" });
    await verifyVercelProject(vercelToken, vercelOrgId, vercelProjectId);
    await emit?.({ type: "step", label: "Verifying Vercel project", status: "done" });
  }

  await emit?.({ type: "step", label: "Scanning repository", status: "running" });
  const scan = await scanRepository(repoFullName, token);
  await emit?.({ type: "step", label: "Scanning repository", status: "done" });
  if (scan.branches.scenario === "custom_required" && !customProdBranch) {
    throw new Error("Production branch is required because ShipBrain could not detect main, master, or develop.");
  }

  const prodBranch = customProdBranch || scan.branches.productionBranch || repo.default_branch || "main";
  const devBranch = customDevBranch || scan.branches.developmentBranch;
  const shipbrainApiKey = generateShipBrainApiKey();
  const apiUrl = publicShipBrainApiUrl(request);
  const secretSteps: string[] = [];

  const secrets: Array<[string, string, boolean]> = [
    ["VERCEL_TOKEN", vercelToken, !skipVercel],
    ["VERCEL_ORG_ID", vercelOrgId, !skipVercel],
    ["VERCEL_PROJECT_ID", vercelProjectId, !skipVercel],
    ["SHIPBRAIN_API_KEY", shipbrainApiKey, true],
    ["SHIPBRAIN_API_URL", apiUrl, true]
  ];

  for (const [name, value, enabled] of secrets) {
    if (!enabled) continue;
    await emit?.({ type: "step", label: `Injecting ${name}`, status: "running" });
    await putActionsSecret(repoFullName, name, value, token);
    secretSteps.push(name);
    await emit?.({ type: "step", label: `Injecting ${name}`, status: "done" });
  }

  await emit?.({ type: "step", label: "Preparing workflow files", status: "running" });
  const files = workflowFiles({
    devBranch,
    prodBranch,
    includeVercel: !skipVercel,
    includeIncidents: !skipIncidents,
    ciExists: scan.workflows.ci,
    deployExists: scan.workflows.deploy,
    incidentsExists: scan.workflows.incidents,
    packageJson: scan.project.packageJson
  });
  await emit?.({ type: "step", label: "Preparing workflow files", status: "done", files: Object.keys(files) });

  let pr: Awaited<ReturnType<typeof openSetupPullRequest>> | null = null;
  if (Object.keys(files).length) {
    await emit?.({ type: "step", label: "Opening GitHub setup PR", status: "running" });
    pr = await openSetupPullRequest({ repoFullName, base: prodBranch, files, token });
    await emit?.({ type: "step", label: "Opening GitHub setup PR", status: "done", prUrl: pr.html_url });
  } else {
    await emit?.({ type: "step", label: "Workflow files already configured", status: "done" });
  }

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
          skipVercel,
          skipIncidents,
          injectedSecrets: secretSteps,
          filesAdded: Object.keys(files),
          apiUrl,
          vercelSettingsUrl: providedVercelSettingsUrl,
          vercelProjectId: skipVercel ? null : vercelProjectId,
          vercelOrgId: skipVercel ? null : vercelOrgId
        }
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
    scan,
    pr,
    injectedSecrets: secretSteps,
    filesAdded: Object.keys(files),
    shipbrainApiKey
  };
}
