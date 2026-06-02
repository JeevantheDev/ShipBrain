import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { deployPreview, buildActionContext } from "@/lib/actions";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user: authUser }
  } = await supabase.auth.getUser();

  const body = await request.json();

  const internalUserId = body.internalUserId || request.headers.get("X-Internal-User-Id");
  const user = authUser || (internalUserId ? { id: internalUserId, email: null } : null) as any;
  const isInternalCall = !authUser && !!internalUserId;

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const specId = String(body.specId ?? "");
  if (!specId) {
    return NextResponse.json({ error: "specId is required" }, { status: 400 });
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
  const result = await deployPreview(ctx, { specId });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error || result.message },
      { status: 409 }
    );
  }

  return NextResponse.json({
    ok: true,
    workflowUrl: result.data?.workflowUrl,
    message: result.message
  });
}
