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
      await supabase.from("profiles").upsert({
        id: data.user.id,
        github_login: data.user.user_metadata?.user_name ?? data.user.user_metadata?.preferred_username ?? null,
        github_access_token: data.session?.provider_token ?? null,
        avatar_url: data.user.user_metadata?.avatar_url ?? null
      });
    }
  }

  return NextResponse.redirect(new URL(next, requestUrl.origin));
}
