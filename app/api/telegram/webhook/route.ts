import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { sendTelegramMessage } from "@/lib/telegram/client";
import { runTelegramCommand } from "@/lib/telegram/tools";
import { toTelegramMarkdown, escapeMarkdown } from "@/lib/telegram/formatter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function makeVerificationCode() {
  return `tg-${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

function verifyTelegramSecret(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return request.headers.get("x-telegram-bot-api-secret-token") === expected;
}

export async function POST(request: Request) {
  if (!verifyTelegramSecret(request)) {
    return NextResponse.json({ error: "Invalid Telegram webhook secret." }, { status: 401 });
  }

  const update = await request.json().catch(() => ({}));
  const updateId = typeof update.update_id === "number" ? update.update_id : null;
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = String(message?.text ?? "").trim();
  const username = message?.from?.username ?? message?.chat?.username ?? null;

  if (!chatId || !text) return NextResponse.json({ ok: true, skipped: true });

  const db = getSupabaseAdminClient();
  if (updateId !== null) {
    const { data: existingUpdate } = await db
      .from("telegram_webhook_updates")
      .select("status, error_fingerprint")
      .eq("update_id", updateId)
      .maybeSingle();

    if (existingUpdate?.status === "processed" || existingUpdate?.status === "error_sent") {
      return NextResponse.json({ ok: true, deduped: true });
    }

    await db.from("telegram_webhook_updates").upsert({
      update_id: updateId,
      telegram_chat_id: chatId,
      status: "processing",
      updated_at: new Date().toISOString()
    }, { onConflict: "update_id" });
  }

  const { data: telegramUser } = await db
    .from("telegram_users")
    .select("id, user_id, verified, verification_code")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();

  try {
    if (text.startsWith("/start") || !telegramUser) {
      const code = telegramUser?.verification_code ?? makeVerificationCode();
      await db.from("telegram_users").upsert({
        telegram_chat_id: chatId,
        telegram_username: username,
        verification_code: code,
        verified: telegramUser?.verified ?? false,
        updated_at: new Date().toISOString()
      }, { onConflict: "telegram_chat_id" });

      await sendTelegramMessage({
        chatId,
        text: telegramUser?.verified
          ? "✅ ShipBrain is already linked. Try /prs, /deployments, /incidents, /releases, or /ci."
          : [
              "👋 *ShipBrain Telegram Assistant*",
              "",
              "Link this chat from ShipBrain Settings → Secrets → Telegram.",
              "",
              `Verification code: \`${code}\``
            ].join("\n"),
        parseMode: "Markdown"
      });
      if (updateId !== null) {
        await db.from("telegram_webhook_updates").update({
          status: "processed",
          updated_at: new Date().toISOString()
        }).eq("update_id", updateId);
      }
      return NextResponse.json({ ok: true });
    }

    if (!telegramUser.verified || !telegramUser.user_id) {
      await sendTelegramMessage({
        chatId,
        text: [
          "This chat is not linked yet.",
          "",
          "Open ShipBrain Settings → Secrets → Telegram and enter:",
          `\`${telegramUser.verification_code}\``
        ].join("\n"),
        parseMode: "Markdown"
      });
      if (updateId !== null) {
        await db.from("telegram_webhook_updates").update({
          status: "processed",
          updated_at: new Date().toISOString()
        }).eq("update_id", updateId);
      }
      return NextResponse.json({ ok: true, unverified: true });
    }

    const reply = await runTelegramCommand({ user_id: telegramUser.user_id }, text);
    await sendTelegramMessage({ chatId, text: toTelegramMarkdown(reply), parseMode: "Markdown" });
    if (updateId !== null) {
      await db.from("telegram_webhook_updates").update({
        status: "processed",
        updated_at: new Date().toISOString()
      }).eq("update_id", updateId);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unable to process the message.";
    const fingerprint = `${text.slice(0, 80)}:${detail.slice(0, 160)}`;
    if (updateId !== null) {
      const { data: current } = await db
        .from("telegram_webhook_updates")
        .select("status, error_fingerprint")
        .eq("update_id", updateId)
        .maybeSingle();
      if (current?.status === "error_sent" && current.error_fingerprint === fingerprint) {
        return NextResponse.json({ ok: true, errorDeduped: true });
      }
    }

    await sendTelegramMessage({
      chatId,
      text: [
        "*ShipBrain Telegram needs attention.*",
        "",
        escapeMarkdown(detail),
        "",
        "Send a new command when you are ready; I will not repeat this same failed update."
      ].join("\n"),
      parseMode: "Markdown"
    }).catch(() => undefined);
    if (updateId !== null) {
      await db.from("telegram_webhook_updates").update({
        status: "error_sent",
        error_fingerprint: fingerprint,
        error_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("update_id", updateId);
    }
    return NextResponse.json({ ok: true, error: "Telegram message failed.", detail });
  }
}
