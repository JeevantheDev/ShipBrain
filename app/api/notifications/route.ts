import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [itemsResult, unreadResult] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, type, title, body, href, severity, repo_full_name, metadata, read_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("read_at", null)
  ]);

  if (itemsResult.error) {
    return NextResponse.json({ error: "Unable to load notifications.", detail: itemsResult.error.message }, { status: 500 });
  }

  return NextResponse.json({
    notifications: itemsResult.data ?? [],
    unreadCount: unreadResult.count ?? 0
  });
}

export async function PATCH(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : null;
  const markAll = Boolean(body.markAll);
  const readAt = new Date().toISOString();

  let query = supabase
    .from("notifications")
    .update({ read_at: readAt })
    .eq("user_id", user.id)
    .is("read_at", null);

  if (!markAll && id) {
    query = query.eq("id", id);
  } else if (!markAll) {
    return NextResponse.json({ error: "Notification id is required." }, { status: 400 });
  }

  const { error } = await query;
  if (error) return NextResponse.json({ error: "Unable to mark notification read.", detail: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("notifications")
    .delete()
    .eq("user_id", user.id)
    .not("read_at", "is", null);

  if (error) return NextResponse.json({ error: "Unable to clear read notifications.", detail: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
