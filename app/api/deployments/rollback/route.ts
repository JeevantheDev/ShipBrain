import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { rollback, buildActionContext } from "@/lib/actions";

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

  const targetReleaseTag = String(body.targetReleaseTag ?? "").trim();
  const repoFullName = body.repoFullName ? String(body.repoFullName) : undefined;

  if (!targetReleaseTag) {
    return NextResponse.json({ error: "targetReleaseTag is required." }, { status: 400 });
  }

  // Use admin client for internal calls to bypass RLS
  const db = isInternalCall ? getSupabaseAdminClient() : supabase;

  // Build action context
  const ctx = await buildActionContext({
    db,
    userId: user.id,
    source: isInternalCall ? "system" : "ui",
    actor: user.email || user.id,
    repoFullName
  });

  if (!ctx) {
    return NextResponse.json(
      { error: "GitHub is not connected. Please connect your GitHub account in Settings." },
      { status: 409 }
    );
  }

  // Execute unified rollback action
  const result = await rollback(ctx, {
    targetReleaseTag,
    repoFullName: repoFullName || ctx.repoFullName
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error || result.message },
      { status: 409 }
    );
  }

  return NextResponse.json({
    ok: true,
    rollbackId: result.data?.rollbackId,
    workflowUrl: result.data?.workflowUrl,
    targetTag: result.data?.targetTag,
    sourceTag: result.data?.sourceTag,
    specsRolledBack: result.data?.specsRolledBack,
    tracesUpdated: result.data?.tracesUpdated,
    message: result.message
  });
}
