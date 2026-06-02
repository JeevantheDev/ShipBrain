import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { deployProduction, buildActionContext } from "@/lib/actions";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user: authUser }
  } = await supabase.auth.getUser();

  const body = await request.json();

  // Support internal server-to-server calls with internalUserId
  const internalUserId = body.internalUserId || request.headers.get("X-Internal-User-Id");
  const user = authUser || (internalUserId ? { id: internalUserId, email: null } : null);
  const isInternalCall = !authUser && !!internalUserId;

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const specId = String(body.specId ?? "");
  const releaseTag = String(body.releaseTag ?? "").trim();
  const releaseSha = String(body.releaseSha ?? "").trim();
  const forceRedeploy = body.forceRedeploy === true;

  if (!specId) {
    return NextResponse.json({ error: "specId is required" }, { status: 400 });
  }

  if (!releaseTag) {
    return NextResponse.json(
      { error: "Release tag is required.", detail: "Confirm or edit the release tag in the Deploy to Production modal before starting deployment." },
      { status: 400 }
    );
  }

  // Use admin client for internal calls to bypass RLS
  const db = isInternalCall ? getSupabaseAdminClient() : supabase;

  // Build action context
  const ctx = await buildActionContext({
    db,
    userId: user.id,
    source: isInternalCall ? "system" : "ui",
    actor: user.email || user.id
  });

  if (!ctx) {
    return NextResponse.json(
      { error: "GitHub is not connected. Please connect your GitHub account in Settings." },
      { status: 409 }
    );
  }

  // Execute unified action
  const result = await deployProduction(ctx, {
    specId,
    releaseTag,
    releaseSha: releaseSha || undefined,
    forceRedeploy
  } as any);

  if (!result.ok) {
    // Check for specific action hints
    if (result.error?.includes("already deployed")) {
      return NextResponse.json(
        {
          error: result.error,
          action: "redeploy_production",
          currentReleaseTag: releaseTag
        },
        { status: 409 }
      );
    }

    if (result.error?.includes("No release PR exists")) {
      return NextResponse.json(
        {
          error: result.error,
          action: "create_release_pr"
        },
        { status: 409 }
      );
    }

    if (result.error?.includes("not merged yet")) {
      return NextResponse.json(
        {
          error: result.error,
          action: "merge_release_pr"
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: result.error || result.message },
      { status: 409 }
    );
  }

  return NextResponse.json({
    ok: true,
    releaseTag: result.data?.releaseTag,
    releaseSha: result.data?.releaseSha,
    workflowUrl: result.data?.workflowUrl,
    message: result.message
  });
}
