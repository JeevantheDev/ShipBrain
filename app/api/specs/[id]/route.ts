import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = getSupabaseServerClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Try to find the spec by full ID or short ID prefix
  let query = supabase
    .from("specs")
    .select(
      "id, status, repo_full_name, branch_name, base_branch, pr_number, pr_url, preview_url, release_tag, release_sha, release_status, deployment_status, preview_status, decomposed_tasks, updated_at, created_at"
    )
    .eq("user_id", user.id);

  // If it's a short ID (8 chars), use prefix matching
  if (id.length === 8) {
    query = query.ilike("id", `${id}%`);
  } else {
    query = query.eq("id", id);
  }

  const { data: spec, error } = await query.maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Failed to fetch spec", detail: error.message }, { status: 500 });
  }

  if (!spec) {
    return NextResponse.json({ error: "Spec not found" }, { status: 404 });
  }

  return NextResponse.json(spec);
}
