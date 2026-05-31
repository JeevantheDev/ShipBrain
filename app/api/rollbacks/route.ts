import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const repo = searchParams.get("repo");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 50);

  let query = supabase
    .from("rollback_history")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (repo) {
    query = query.eq("repo_full_name", repo);
  }

  const { data: rollbacks, error } = await query;

  if (error) {
    return NextResponse.json({ error: "Unable to load rollback history.", detail: error.message }, { status: 500 });
  }

  return NextResponse.json(rollbacks ?? []);
}
