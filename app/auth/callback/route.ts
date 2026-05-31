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
      // Try to get token from multiple sources
      let token = data.session?.provider_token;

      // If no provider_token in session, try to get from provider_refresh_token
      // or from the user's GitHub identity
      if (!token) {
        const githubIdentity = data.user.identities?.find(id => id.provider === "github");
        // The access_token might be in identity_data for some Supabase versions
        token = (githubIdentity?.identity_data as any)?.access_token ?? null;
      }

      let githubLogin = data.user.user_metadata?.user_name ?? data.user.user_metadata?.preferred_username ?? null;
      let avatarUrl = data.user.user_metadata?.avatar_url ?? null;

      // Only update profile if we have a valid token
      if (token) {
        try {
          const { getOctokit } = await import("@/lib/github/client");
          const octokit = getOctokit(token);
          const { data: githubUser } = await octokit.users.getAuthenticated();
          githubLogin = githubUser.login;
          avatarUrl = githubUser.avatar_url;
        } catch (e) {
          console.error("Failed to fetch GitHub user details in callback:", e);
          // Token might be invalid, don't store it
          token = null;
        }

        if (token) {
          await supabase.from("profiles").upsert({
            id: data.user.id,
            github_login: githubLogin,
            github_access_token: token,
            avatar_url: avatarUrl
          });
          console.log(`GitHub token stored for user ${data.user.id} (${githubLogin})`);
        }
      } else {
        // No token available - just update login/avatar if we have them, don't clear existing token
        console.warn("No GitHub provider_token in session for user:", data.user.id);

        // Check if user already has a token stored, don't overwrite it
        const { data: existingProfile } = await supabase
          .from("profiles")
          .select("github_access_token")
          .eq("id", data.user.id)
          .maybeSingle();

        if (!existingProfile?.github_access_token) {
          // Only update non-token fields if no existing token
          await supabase.from("profiles").upsert({
            id: data.user.id,
            github_login: githubLogin,
            avatar_url: avatarUrl
          });
        }
      }
    } else if (error) {
      console.error("Auth callback error:", error.message);
    }
  }

  return NextResponse.redirect(new URL(next, requestUrl.origin));
}
