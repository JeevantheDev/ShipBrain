import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = getSupabaseServerClient();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("github_access_token")
    .eq("id", user.id)
    .maybeSingle();

  const token = profile?.github_access_token ?? session?.provider_token;

  if (!token) {
    return NextResponse.json({ error: "GitHub is not connected.", requiresGithub: true }, { status: 409 });
  }

  const { data: connectedRepos } = await supabase
    .from("repos")
    .select("github_repo_id, full_name")
    .eq("user_id", user.id);
  const connected = new Set((connectedRepos ?? []).map((repo) => repo.full_name));

  const octokit = getOctokit(token);
  const { data } = await octokit.repos.listForAuthenticatedUser({ sort: "updated", per_page: 100 });

  return NextResponse.json(
    data.map((repo) => ({
      id: repo.id,
      full_name: repo.full_name,
      default_branch: repo.default_branch,
      private: repo.private,
      connected: connected.has(repo.full_name)
    }))
  );
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const repos = Array.isArray(body.repos) ? body.repos : [];
  if (!repos.length) return NextResponse.json({ error: "Select at least one repository." }, { status: 400 });

  await supabase.from("profiles").upsert({ id: user.id });

  const payload = repos.map((repo: any) => ({
    user_id: user.id,
    github_repo_id: repo.id,
    full_name: repo.full_name,
    default_branch: repo.default_branch ?? "main"
  }));

  const { error } = await supabase
    .from("repos")
    .upsert(payload, { onConflict: "user_id,full_name" });

  if (error) return NextResponse.json({ error: "Unable to save repository connections.", detail: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, connected: payload.length });
}

export async function DELETE(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const fullName = body.fullName;

  if (!fullName) return NextResponse.json({ error: "Repository name is required." }, { status: 400 });

  // Delete the repo connection
  const { error: repoError } = await supabase
    .from("repos")
    .delete()
    .eq("user_id", user.id)
    .eq("full_name", fullName);

  if (repoError) return NextResponse.json({ error: "Unable to disconnect repository.", detail: repoError.message }, { status: 500 });

  // Also delete any specs associated with this repo
  await supabase
    .from("specs")
    .delete()
    .eq("user_id", user.id)
    .eq("repo_full_name", fullName);

  return NextResponse.json({ ok: true, disconnected: fullName });
}
