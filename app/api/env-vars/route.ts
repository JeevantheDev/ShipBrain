import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getCloudflareProject, setProjectEnvVars } from "@/lib/cloudflare/client";

export const runtime = "nodejs";

/**
 * GET - Fetch environment variables for a repo's Cloudflare project
 */
export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const repoFullName = url.searchParams.get("repo");

  if (!repoFullName) {
    return NextResponse.json({ error: "repo parameter is required" }, { status: 400 });
  }

  // Get repo from database with Cloudflare metadata
  const { data: repo, error: repoError } = await supabase
    .from("repos")
    .select("id, full_name, setup_metadata")
    .eq("full_name", repoFullName)
    .eq("user_id", user.id)
    .single();

  if (repoError || !repo) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }

  const cloudflareProjectName = (repo.setup_metadata as any)?.cloudflareProjectName;
  const cloudflareAccountId = (repo.setup_metadata as any)?.cloudflareAccountId;
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!cloudflareProjectName || !cloudflareAccountId || !cloudflareApiToken) {
    return NextResponse.json({
      error: "Cloudflare project not configured for this repository",
      envVars: { preview: {}, production: {} }
    }, { status: 200 });
  }

  try {
    const projectResult = await getCloudflareProject({
      apiToken: cloudflareApiToken,
      accountId: cloudflareAccountId,
      projectName: cloudflareProjectName
    });

    if (!projectResult.success || !projectResult.project) {
      return NextResponse.json({
        error: "Unable to fetch Cloudflare project",
        envVars: { preview: {}, production: {} }
      }, { status: 200 });
    }

    const project = projectResult.project;

    // Extract env vars (keys only for security - values are masked)
    const previewEnvVars = project.deployment_configs?.preview?.env_vars ?? {};
    const productionEnvVars = project.deployment_configs?.production?.env_vars ?? {};

    // Return keys with masked values
    const formatEnvVars = (vars: Record<string, { value: string; type?: string }>) => {
      return Object.entries(vars).map(([key, config]) => ({
        key,
        value: "••••••••", // Always mask values for security
        type: config.type || "plain_text"
      }));
    };

    return NextResponse.json({
      projectName: cloudflareProjectName,
      projectUrl: projectResult.projectUrl,
      envVars: {
        preview: formatEnvVars(previewEnvVars),
        production: formatEnvVars(productionEnvVars)
      }
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to fetch environment variables",
      envVars: { preview: [], production: [] }
    }, { status: 500 });
  }
}

/**
 * POST - Set environment variables for a repo's Cloudflare project
 */
export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { repo: repoFullName, envVars, environment = "both" } = body;

  if (!repoFullName) {
    return NextResponse.json({ error: "repo is required" }, { status: 400 });
  }

  if (!envVars || typeof envVars !== "object") {
    return NextResponse.json({ error: "envVars object is required" }, { status: 400 });
  }

  // Validate environment parameter
  if (!["preview", "production", "both"].includes(environment)) {
    return NextResponse.json({ error: "environment must be 'preview', 'production', or 'both'" }, { status: 400 });
  }

  // Get repo from database with Cloudflare metadata
  const { data: repo, error: repoError } = await supabase
    .from("repos")
    .select("id, full_name, setup_metadata")
    .eq("full_name", repoFullName)
    .eq("user_id", user.id)
    .single();

  if (repoError || !repo) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }

  const cloudflareProjectName = (repo.setup_metadata as any)?.cloudflareProjectName;
  const cloudflareAccountId = (repo.setup_metadata as any)?.cloudflareAccountId;
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!cloudflareProjectName || !cloudflareAccountId || !cloudflareApiToken) {
    return NextResponse.json({ error: "Cloudflare project not configured for this repository" }, { status: 400 });
  }

  try {
    const result = await setProjectEnvVars({
      apiToken: cloudflareApiToken,
      accountId: cloudflareAccountId,
      projectName: cloudflareProjectName,
      envVars,
      environment
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Unable to set environment variables" }, { status: 500 });
    }

    // Log the action
    await supabase.from("approval_events").insert({
      entity_type: "repo",
      entity_id: repo.id,
      action: "env_vars_updated",
      actor_id: user.id,
      note: `Updated environment variables for ${environment} environment`,
      metadata: {
        repo: repoFullName,
        projectName: cloudflareProjectName,
        environment,
        varCount: Object.keys(envVars).length
      }
    });

    return NextResponse.json({ ok: true, message: "Environment variables updated successfully" });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to set environment variables"
    }, { status: 500 });
  }
}

/**
 * DELETE - Remove an environment variable from a repo's Cloudflare project
 */
export async function DELETE(request: Request) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { repo: repoFullName, key, environment = "both" } = body;

  if (!repoFullName || !key) {
    return NextResponse.json({ error: "repo and key are required" }, { status: 400 });
  }

  // Get repo from database with Cloudflare metadata
  const { data: repo, error: repoError } = await supabase
    .from("repos")
    .select("id, full_name, setup_metadata")
    .eq("full_name", repoFullName)
    .eq("user_id", user.id)
    .single();

  if (repoError || !repo) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }

  const cloudflareProjectName = (repo.setup_metadata as any)?.cloudflareProjectName;
  const cloudflareAccountId = (repo.setup_metadata as any)?.cloudflareAccountId;
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!cloudflareProjectName || !cloudflareAccountId || !cloudflareApiToken) {
    return NextResponse.json({ error: "Cloudflare project not configured for this repository" }, { status: 400 });
  }

  // To delete a variable, we need to get current vars and remove the key
  // Cloudflare doesn't have a direct delete API - we patch with the var removed
  try {
    const projectResult = await getCloudflareProject({
      apiToken: cloudflareApiToken,
      accountId: cloudflareAccountId,
      projectName: cloudflareProjectName
    });

    if (!projectResult.success || !projectResult.project) {
      return NextResponse.json({ error: "Unable to fetch Cloudflare project" }, { status: 500 });
    }

    // Note: Cloudflare doesn't support deleting individual env vars via API easily
    // For now, return an error suggesting they use the Cloudflare dashboard
    return NextResponse.json({
      error: "Deleting individual environment variables is not supported via API. Use the Cloudflare dashboard to remove variables, or set the variable to an empty value."
    }, { status: 400 });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to delete environment variable"
    }, { status: 500 });
  }
}
