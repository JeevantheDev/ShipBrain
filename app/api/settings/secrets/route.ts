import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { deleteActionsSecret, putActionsSecret } from "@/lib/github/setup";
import { generateShipBrainApiKey, hashShipBrainApiKey, lastFour } from "@/lib/shipbrain/api-keys";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

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

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

function setupStatusFromPullRequest(pr: { state?: string; merged?: boolean | null } | null, currentStatus: string) {
  if (!pr) return currentStatus;
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.state === "open") return "pr_opened";
  return currentStatus;
}

async function syncSetupPrStatuses(supabase: ReturnType<typeof getSupabaseServerClient>, userId: string, token: string | null, repos: any[]) {
  if (!token) return repos;
  const octokit = getOctokit(token);
  const synced = [];
  for (const repo of repos) {
    if (!repo.setup_pr_number || !repo.full_name?.includes("/")) {
      synced.push(repo);
      continue;
    }
    try {
      const { owner, repo: repoName } = splitRepo(repo.full_name);
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo: repoName,
        pull_number: repo.setup_pr_number
      });
      const nextStatus = setupStatusFromPullRequest(pr, repo.setup_status);
      const nextUrl = pr.html_url ?? repo.setup_pr_url;
      const nextMetadata = {
        ...((repo.setup_metadata && typeof repo.setup_metadata === "object") ? repo.setup_metadata : {}),
        setupPrState: pr.state,
        setupPrMerged: Boolean(pr.merged),
        setupPrSyncedAt: new Date().toISOString()
      };
      if (nextStatus !== repo.setup_status || nextUrl !== repo.setup_pr_url) {
        await supabase
          .from("repos")
          .update({ setup_status: nextStatus, setup_pr_url: nextUrl, setup_metadata: nextMetadata })
          .eq("id", repo.id)
          .eq("user_id", userId);
      }
      synced.push({ ...repo, setup_status: nextStatus, setup_pr_url: nextUrl, setup_metadata: nextMetadata });
    } catch {
      synced.push(repo);
    }
  }
  return synced;
}

function normalizeSecretUpdates(input: unknown) {
  const allowed = new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_PROJECT_NAME", "SHIPBRAIN_API_URL"]);
  if (!input || typeof input !== "object") return [];
  return Object.entries(input as Record<string, unknown>)
    .map(([name, value]) => [name, String(value ?? "").trim()] as const)
    .filter(([name, value]) => allowed.has(name) && value.length > 0);
}

function getPublicShipBrainApiUrl(request: Request) {
  const configured =
    process.env.SHIPBRAIN_API_URL ??
    process.env.NEXT_PUBLIC_SHIPBRAIN_API_URL ??
    process.env.VERCEL_URL ??
    process.env.NGROK_PUBLIC_URL ??
    process.env.NGROK_URL;

  if (configured?.trim()) {
    let url = configured.trim();
    // Add https:// if it's a Vercel URL without protocol
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = `https://${url}`;
    }
    return url.replace(/\/$/, "");
  }

  const origin = new URL(request.url).origin;
  return origin.replace(/\/$/, "");
}

export async function GET() {
  const { supabase, user, token } = await getContext();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("repos")
    .select("id, full_name, connected_at, created_at, setup_status, setup_pr_number, setup_pr_url, shipbrain_api_key_last4, setup_metadata")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: "Unable to load secrets.", detail: error.message }, { status: 500 });
  const synced = await syncSetupPrStatuses(supabase, user.id, token, data ?? []);
  return NextResponse.json(synced);
}

export async function POST(request: Request) {
  const { supabase, user, token } = await getContext();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!token) return NextResponse.json({ error: "GitHub is not connected.", requiresGithub: true }, { status: 409 });

  const body = await request.json();
  const repoId = String(body.repoId ?? "");
  const action = String(body.action ?? "");
  const { data: repo, error: repoError } = await supabase
    .from("repos")
    .select("id, full_name, setup_metadata, shipbrain_api_key_last4")
    .eq("id", repoId)
    .eq("user_id", user.id)
    .single();

  if (repoError || !repo) return NextResponse.json({ error: "Repository was not found." }, { status: 404 });

  if (action === "rotate_api_key") {
    const nextKey = generateShipBrainApiKey();
    await putActionsSecret(repo.full_name, "SHIPBRAIN_API_KEY", nextKey, token);
    const currentMetadata = (repo.setup_metadata && typeof repo.setup_metadata === "object") ? repo.setup_metadata : {};
    const injectedSecrets = Array.from(new Set([...(Array.isArray((currentMetadata as any).injectedSecrets) ? (currentMetadata as any).injectedSecrets : []), "SHIPBRAIN_API_KEY"]));
    const { error } = await supabase
      .from("repos")
      .update({
        shipbrain_api_key_hash: hashShipBrainApiKey(nextKey),
        shipbrain_api_key_last4: lastFour(nextKey),
        setup_metadata: {
          ...currentMetadata,
          injectedSecrets,
          rotatedAt: new Date().toISOString()
        }
      })
      .eq("id", repo.id);
    if (error) return NextResponse.json({ error: "API key rotated in GitHub, but ShipBrain could not update its record.", detail: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, shipbrainApiKey: nextKey });
  }

  if (action === "update_secrets") {
    const updates = normalizeSecretUpdates(body.secrets);
    if (!updates.length) return NextResponse.json({ error: "Enter at least one changed secret value before saving." }, { status: 400 });
    for (const [name, value] of updates) {
      await putActionsSecret(repo.full_name, name, value, token);
    }
    const currentMetadata = (repo.setup_metadata && typeof repo.setup_metadata === "object") ? repo.setup_metadata : {};
    const injectedSecrets = Array.from(new Set([
      ...(Array.isArray((currentMetadata as any).injectedSecrets) ? (currentMetadata as any).injectedSecrets : []),
      ...updates.map(([name]) => name)
    ]));
    const changed = Object.fromEntries(updates);
    const nextMetadata = {
      ...currentMetadata,
      injectedSecrets,
      ...(changed.SHIPBRAIN_API_URL ? { apiUrl: changed.SHIPBRAIN_API_URL } : {}),
      ...(changed.CLOUDFLARE_ACCOUNT_ID ? { cloudflareAccountId: changed.CLOUDFLARE_ACCOUNT_ID } : {}),
      ...(changed.CF_PROJECT_NAME ? { cloudflareProjectName: changed.CF_PROJECT_NAME } : {}),
      secretsUpdatedAt: new Date().toISOString()
    };
    const { error } = await supabase
      .from("repos")
      .update({ setup_metadata: nextMetadata })
      .eq("id", repo.id)
      .eq("user_id", user.id);
    if (error) return NextResponse.json({ error: "Secrets updated in GitHub, but ShipBrain could not update the repo record.", detail: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, updatedSecrets: updates.map(([name]) => name), setup_metadata: nextMetadata });
  }

  if (action === "sync_to_github") {
    // Get or generate API key
    const currentMetadata = (repo.setup_metadata && typeof repo.setup_metadata === "object") ? repo.setup_metadata : {};
    let apiKey = generateShipBrainApiKey();

    // Get the public API URL
    const apiUrl = getPublicShipBrainApiUrl(request);

    // Push both secrets to GitHub
    const syncedSecrets: string[] = [];

    await putActionsSecret(repo.full_name, "SHIPBRAIN_API_URL", apiUrl, token);
    syncedSecrets.push("SHIPBRAIN_API_URL");

    await putActionsSecret(repo.full_name, "SHIPBRAIN_API_KEY", apiKey, token);
    syncedSecrets.push("SHIPBRAIN_API_KEY");

    // Update the repo record
    const injectedSecrets = Array.from(new Set([
      ...(Array.isArray((currentMetadata as any).injectedSecrets) ? (currentMetadata as any).injectedSecrets : []),
      ...syncedSecrets
    ]));

    const { error } = await supabase
      .from("repos")
      .update({
        shipbrain_api_key_hash: hashShipBrainApiKey(apiKey),
        shipbrain_api_key_last4: lastFour(apiKey),
        setup_metadata: {
          ...currentMetadata,
          injectedSecrets,
          apiUrl,
          syncedAt: new Date().toISOString()
        }
      })
      .eq("id", repo.id);

    if (error) {
      return NextResponse.json({
        error: "Secrets synced to GitHub, but ShipBrain could not update the repo record.",
        detail: error.message
      }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      syncedSecrets,
      apiUrl,
      shipbrainApiKey: apiKey,
      message: `Synced SHIPBRAIN_API_URL (${apiUrl}) and SHIPBRAIN_API_KEY to GitHub`
    });
  }

  if (action === "disconnect") {
    const confirmation = String(body.confirmation ?? "");
    if (confirmation !== repo.full_name) {
      return NextResponse.json({ error: "Type the exact repo name to disconnect." }, { status: 400 });
    }
    const secrets = ["PAGERDUTY_ROUTING_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_PROJECT_NAME", "SHIPBRAIN_API_KEY", "SHIPBRAIN_API_URL"];
    const results = await Promise.allSettled(secrets.map((secret) => deleteActionsSecret(repo.full_name, secret, token)));
    const failed = results
      .map((result, index) => result.status === "rejected" ? secrets[index] : "")
      .filter(Boolean);
    if (failed.length) {
      return NextResponse.json(
        { error: "ShipBrain could not remove every GitHub secret.", detail: `Failed: ${failed.join(", ")}` },
        { status: 500 }
      );
    }
    const { error } = await supabase.from("repos").delete().eq("id", repo.id).eq("user_id", user.id);
    if (error) return NextResponse.json({ error: "GitHub secrets removed, but ShipBrain could not delete the repo record.", detail: error.message }, { status: 500 });

    // Also delete any specs associated with this repo
    await supabase
      .from("specs")
      .delete()
      .eq("user_id", user.id)
      .eq("repo_full_name", repo.full_name);

    // Delete any CI runs associated with this repo
    await supabase
      .from("ci_runs")
      .delete()
      .eq("repo_full_name", repo.full_name);

    // Delete any incidents associated with this repo
    await supabase
      .from("incidents")
      .delete()
      .eq("user_id", user.id)
      .eq("repo_full_name", repo.full_name);

    // Delete any approval events associated with this repo
    await supabase
      .from("approval_events")
      .delete()
      .eq("metadata->>repo", repo.full_name);

    return NextResponse.json({ ok: true, removedSecrets: secrets });
  }

  return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 });
}
