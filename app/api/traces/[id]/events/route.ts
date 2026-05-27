import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: trace } = await supabase
    .from("release_traces")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!trace) return NextResponse.json({ error: "Trace not found." }, { status: 404 });

  const { data, error } = await supabase
    .from("trace_events")
    .select("*")
    .eq("trace_id", params.id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Unable to load trace events.", detail: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
