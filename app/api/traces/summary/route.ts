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

  const { data, error } = await supabase
    .from("release_traces")
    .select("status, pending_action, completed_at")
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: "Unable to load trace summary.", detail: error.message }, { status: 500 });

  const today = new Date().toISOString().slice(0, 10);
  const traces = data ?? [];
  return NextResponse.json({
    total: traces.length,
    active: traces.filter((trace) => !["completed", "cancelled"].includes(trace.status)).length,
    pending: traces.filter((trace) => trace.pending_action).length,
    failed: traces.filter((trace) => trace.status === "failed").length,
    completedToday: traces.filter((trace) => trace.completed_at?.startsWith(today)).length
  });
}
