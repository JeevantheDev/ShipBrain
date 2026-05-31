import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") ?? "/";

  if (code) {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data.user) {
      const token = data.session?.provider_token;
      let githubLogin = data.user.user_metadata?.user_name ?? data.user.user_metadata?.preferred_username ?? null;
      let avatarUrl = data.user.user_metadata?.avatar_url ?? null;

      if (token) {
        try {
          const { getOctokit } = await import("@/lib/github/client");
          const octokit = getOctokit(token);
          const { data: githubUser } = await octokit.users.getAuthenticated();
          githubLogin = githubUser.login;
          avatarUrl = githubUser.avatar_url;
        } catch (e) {
          console.error("Failed to fetch GitHub user details in callback:", e);
        }
      }

      await supabase.from("profiles").upsert({
        id: data.user.id,
        github_login: githubLogin,
        github_access_token: token ?? null,
        avatar_url: avatarUrl
      });
    }
  }

  return NextResponse.redirect(new URL(next, requestUrl.origin));
}
