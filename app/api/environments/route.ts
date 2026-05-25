import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get preview environments from specs
  const { data: previews } = await supabase
    .from("specs")
    .select("id, repo_full_name, branch_name, preview_url, preview_status, updated_at")
    .eq("user_id", user.id)
    .not("preview_url", "is", null)
    .eq("preview_status", "deployed")
    .order("updated_at", { ascending: false })
    .limit(5);

  // Get production environments from deployed specs
  const { data: productions } = await supabase
    .from("specs")
    .select("id, repo_full_name, branch_name, deployment_url, release_status, deployed_at, updated_at")
    .eq("user_id", user.id)
    .eq("release_status", "deployed")
    .not("deployment_url", "is", null)
    .order("deployed_at", { ascending: false })
    .limit(5);

  const environments = [
    ...(previews ?? []).map((spec) => ({
      id: `preview-${spec.id}`,
      repo: spec.repo_full_name,
      type: "preview" as const,
      url: spec.preview_url,
      branch: spec.branch_name ?? "develop",
      status: spec.preview_status,
      updatedAt: spec.updated_at
    })),
    ...(productions ?? []).map((spec) => ({
      id: `prod-${spec.id}`,
      repo: spec.repo_full_name,
      type: "production" as const,
      url: spec.deployment_url,
      branch: "main",
      status: spec.release_status,
      updatedAt: spec.deployed_at ?? spec.updated_at
    }))
  ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return NextResponse.json(environments);
}
