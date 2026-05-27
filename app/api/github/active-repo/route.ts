import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("profiles")
    .select("active_repo_full_name")
    .eq("id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Unable to load active repository.", detail: error.message }, { status: 500 });

  return NextResponse.json({ activeRepoFullName: data?.active_repo_full_name ?? null });
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const repoFullName = typeof body.repoFullName === "string" && body.repoFullName.trim()
    ? body.repoFullName.trim()
    : null;

  if (repoFullName) {
    const { data: repo, error: repoError } = await supabase
      .from("repos")
      .select("id")
      .eq("user_id", user.id)
      .eq("full_name", repoFullName)
      .maybeSingle();

    if (repoError) return NextResponse.json({ error: "Unable to validate repository.", detail: repoError.message }, { status: 500 });
    if (!repo) return NextResponse.json({ error: "Repository is not connected to ShipBrain." }, { status: 404 });
  }

  const { error } = await supabase
    .from("profiles")
    .upsert({ id: user.id, active_repo_full_name: repoFullName }, { onConflict: "id" });

  if (error) return NextResponse.json({ error: "Unable to save active repository.", detail: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, activeRepoFullName: repoFullName });
}
