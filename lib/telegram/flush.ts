import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { sendTelegramMessage } from "@/lib/telegram/client";
import { formatNotificationForTelegram } from "@/lib/telegram/formatter";

export async function flushPendingTelegramNotifications(limit = 25) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("telegram_notification_deliveries")
    .select("id, attempts, telegram_users!inner(telegram_chat_id), notifications!inner(title, body, href, severity, repo_full_name)")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);

  let sent = 0;
  let failed = 0;
  for (const delivery of data ?? []) {
    try {
      const chatId = (delivery as any).telegram_users.telegram_chat_id;
      const notification = (delivery as any).notifications;
      await sendTelegramMessage({
        chatId,
        text: formatNotificationForTelegram(notification),
        parseMode: "HTML"
      });
      sent += 1;
      await db.from("telegram_notification_deliveries").update({
        status: "sent",
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        attempts: Number(delivery.attempts ?? 0) + 1
      }).eq("id", delivery.id);
    } catch (error) {
      failed += 1;
      await db.from("telegram_notification_deliveries").update({
        attempts: Number(delivery.attempts ?? 0) + 1,
        last_error: error instanceof Error ? error.message : "Unable to send Telegram notification.",
        updated_at: new Date().toISOString()
      }).eq("id", delivery.id);
    }
  }

  return { sent, failed };
}
