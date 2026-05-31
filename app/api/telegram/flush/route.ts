import { NextResponse } from "next/server";
import { flushPendingTelegramNotifications } from "@/lib/telegram/flush";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const secret = process.env.TELEGRAM_FLUSH_SECRET ?? process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true;
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return auth === secret;
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await flushPendingTelegramNotifications();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: "Unable to flush Telegram deliveries.", detail: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return POST(request);
}
