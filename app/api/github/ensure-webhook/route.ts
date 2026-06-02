import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { ensureGitHubWebhook } from "@/lib/github/setup";
import { resolvePublicShipBrainUrl } from "@/lib/shipbrain/public-url";

export const runtime = "nodejs";

/**
 * POST /api/github/ensure-webhook
 * Creates or updates the GitHub webhook for an already-onboarded repo.
 * Body: { repoFullName: string }
 */
export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const repoFullName = String(body.repoFullName ?? "");

  if (!repoFullName.includes("/")) {
    return NextResponse.json({ error: "repoFullName is required" }, { status: 400 });
  }

  // Verify user owns this repo
  const { data: repo } = await supabase
    .from("repos")
    .select("id, full_name")
    .eq("user_id", user.id)
    .eq("full_name", repoFullName)
    .maybeSingle();

  if (!repo) {
    return NextResponse.json({ error: "Repo not found or not owned by user" }, { status: 404 });
  }

  // Get user's GitHub token
  const { data: profile } = await supabase
    .from("profiles")
    .select("github_access_token")
    .eq("id", user.id)
    .maybeSingle();

  const token = profile?.github_access_token;
  if (!token) {
    return NextResponse.json({ error: "GitHub not connected" }, { status: 409 });
  }

  // Create webhook
  const apiUrl = resolvePublicShipBrainUrl(request, { requirePublicForLocal: true });
  const webhookUrl = `${apiUrl}/api/webhooks/github`;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";

  try {
    const result = await ensureGitHubWebhook(repoFullName, webhookUrl, webhookSecret, token);

    return NextResponse.json({
      ok: true,
      created: result.created,
      hookId: result.hookId,
      webhookUrl,
      message: result.created
        ? "Webhook created successfully"
        : result.hookId
          ? "Webhook already exists and was updated"
          : "Could not create webhook (no admin access)"
    });
  } catch (error: any) {
    return NextResponse.json({
      error: "Failed to create webhook",
      detail: error.message
    }, { status: 500 });
  }
}
