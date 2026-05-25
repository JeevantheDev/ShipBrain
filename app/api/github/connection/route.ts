import { NextResponse } from "next/server";
import { getOctokit } from "@/lib/github/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function getUserOr401() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function GET() {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("profiles")
    .select("github_login, github_access_token, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  return NextResponse.json({
    connected: Boolean(data?.github_access_token),
    githubLogin: data?.github_login ?? null,
    avatarUrl: data?.avatar_url ?? null
  });
}

export async function POST() {
  const { supabase, user } = await getUserOr401();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_TEST_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "GitHub token is not configured. Add GITHUB_TOKEN or GITHUB_TEST_TOKEN to .env.local." },
      { status: 500 }
    );
  }

  try {
    const octokit = getOctokit(token);
    const { data: githubUser } = await octokit.users.getAuthenticated();
    const { error } = await supabase.from("profiles").upsert({
      id: user.id,
      github_login: githubUser.login,
      github_access_token: token,
      avatar_url: githubUser.avatar_url
    });

    if (error) {
      return NextResponse.json({ error: "Unable to save GitHub connection.", detail: error.message }, { status: 500 });
    }

    return NextResponse.json({
      connected: true,
      githubLogin: githubUser.login,
      avatarUrl: githubUser.avatar_url
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Unable to verify GitHub token.", detail: error instanceof Error ? error.message : "GitHub rejected the token." },
      { status: 500 }
    );
  }
}
