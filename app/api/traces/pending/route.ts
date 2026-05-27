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
    .select("*")
    .eq("user_id", user.id)
    .not("pending_action", "is", null)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: "Unable to load pending traces.", detail: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
