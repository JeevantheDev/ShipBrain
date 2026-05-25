import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim();

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      name: name || email.split("@")[0]
    }
  });

  if (error) {
    const message = /already registered|already exists/i.test(error.message)
      ? "This email already has an account. Sign in instead."
      : error.message;
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (data.user) {
    await supabase.from("profiles").upsert({
      id: data.user.id,
      github_login: null,
      avatar_url: null
    });
  }

  return NextResponse.json({ ok: true });
}
