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
  let ctx;
  try {
    ctx = await buildActionContext({
      db,
      userId: user.id,
      source: isInternalCall ? "system" : "ui",
      actor: user.email || user.id
    });
  } catch (ctxError) {
    console.error("[start-preview] buildActionContext threw:", ctxError);
    return NextResponse.json(
      { error: `Context build failed: ${ctxError instanceof Error ? ctxError.message : "Unknown error"}` },
      { status: 500 }
    );
  }

  if (!ctx) {
    // Try to get more info about why ctx is null
    const adminDb = getSupabaseAdminClient();
    const { data: debugProfile, error: debugError } = await adminDb
      .from("profiles")
      .select("id, email, github_access_token")
      .eq("id", user.id)
      .maybeSingle();

    console.error("[start-preview] ctx is null. userId:", user.id, "debugProfile:", debugProfile ? "found" : "not found", "token:", debugProfile?.github_access_token ? "exists" : "missing", "error:", debugError?.message);

    return NextResponse.json(
      {
        error: "GitHub is not connected. Please connect your GitHub account in Settings.",
        debug: {
          userId: user.id,
          profileFound: !!debugProfile,
          tokenExists: !!debugProfile?.github_access_token,
          queryError: debugError?.message
        }
      },
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
