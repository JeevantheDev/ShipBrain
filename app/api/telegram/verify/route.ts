import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { requirePasswordConfirmation } from "@/lib/auth/reauth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { sendTelegramMessage } from "@/lib/telegram/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("telegram_users")
    .select("id, telegram_chat_id, telegram_username, verified, created_at, updated_at")
    .eq("user_id", user.id)
    .eq("verified", true)
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Unable to load Telegram link.", detail: error.message }, { status: 500 });
  return NextResponse.json({ linked: Boolean(data), telegram: data ?? null });
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  try {
    await requirePasswordConfirmation(user, body.reauthPassword);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Password confirmation failed." }, { status: 401 });
  }
  const action = String(body.action ?? "verify");

  if (action === "unlink") {
    const { error } = await admin.from("telegram_users").delete().eq("user_id", user.id);
    if (error) return NextResponse.json({ error: "Unable to unlink Telegram.", detail: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, linked: false });
  }

  if (action === "test") {
    const { data, error } = await admin
      .from("telegram_users")
      .select("telegram_chat_id")
      .eq("user_id", user.id)
      .eq("verified", true)
      .maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Telegram is not linked yet." }, { status: 404 });
    await sendTelegramMessage({ chatId: data.telegram_chat_id, text: "✅ ShipBrain Telegram notifications are working." });
    return NextResponse.json({ ok: true });
  }

  const code = String(body.code ?? "").trim().toUpperCase();
  if (!code) return NextResponse.json({ error: "Verification code is required." }, { status: 400 });

  const normalizedCode = code.replace(/[^A-Z0-9]/g, "");
  const { data: candidates, error: candidateError } = await admin
    .from("telegram_users")
    .select("id, verification_code")
    .eq("verified", false)
    .not("verification_code", "is", null)
    .order("created_at", { ascending: false })
    .limit(25);

  if (candidateError) return NextResponse.json({ error: "Unable to verify Telegram.", detail: candidateError.message }, { status: 500 });

  const match = (candidates ?? []).find((candidate) =>
    String(candidate.verification_code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedCode
  );

  if (!match) return NextResponse.json({ error: "Invalid verification code. Send /start to the bot to get a fresh code." }, { status: 404 });

  const { data, error } = await admin
    .from("telegram_users")
    .update({
      user_id: user.id,
      verified: true,
      verification_code: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", match.id)
    .select("telegram_chat_id, telegram_username")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Unable to verify Telegram.", detail: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Invalid verification code. Send /start to the bot to get a fresh code." }, { status: 404 });

  await sendTelegramMessage({
    chatId: data.telegram_chat_id,
    text: "✅ Telegram is linked to ShipBrain. You will receive enabled repo notifications here."
  }).catch(() => undefined);

  return NextResponse.json({ ok: true, linked: true, telegram: data });
}
