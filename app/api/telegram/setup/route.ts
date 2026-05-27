import { NextResponse } from "next/server";
import { requirePasswordConfirmation } from "@/lib/auth/reauth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { setTelegramCommands, setTelegramWebhook } from "@/lib/telegram/client";

export const runtime = "nodejs";

function publicBaseUrl(request: Request) {
  const configured =
    process.env.SHIPBRAIN_API_URL ??
    process.env.NEXT_PUBLIC_SHIPBRAIN_API_URL ??
    process.env.VERCEL_URL ??
    process.env.NGROK_PUBLIC_URL ??
    process.env.NGROK_URL;
  if (configured?.trim()) {
    const value = configured.trim();
    return (value.startsWith("http") ? value : `https://${value}`).replace(/\/$/, "");
  }
  return new URL(request.url).origin.replace(/\/$/, "");
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
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

  const webhookUrl = `${publicBaseUrl(request)}/api/telegram/webhook`;
  const result = await setTelegramWebhook(webhookUrl);
  const commands = await setTelegramCommands().catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : "Unable to set Telegram commands."
  }));
  return NextResponse.json({ ok: true, webhookUrl, result, commands });
}
