import { NextResponse } from "next/server";
import { appendChatMessage, getOrCreateChatThread, listChatMessages } from "@/lib/ai/chat-store";
import { answerShipBrainQuestion } from "@/lib/ai/shipbrain-chat";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toClientMessage(row: any) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  };
}

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("active_repo_full_name")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    return NextResponse.json({ error: "Unable to load active repo.", detail: profileError.message }, { status: 500 });
  }

  const url = new URL(request.url);
  const thread = await getOrCreateChatThread({
    supabase,
    userId: user.id,
    repoFullName: profile?.active_repo_full_name ?? null,
    channel: "web",
    threadId: url.searchParams.get("threadId"),
    externalThreadKey: url.searchParams.get("externalThreadKey") ?? "default"
  });
  const messages = await listChatMessages({ supabase, userId: user.id, threadId: thread.id, limit: 50 });
  return NextResponse.json({
    threadId: thread.id,
    activeRepo: profile?.active_repo_full_name ?? null,
    messages: messages.map(toClientMessage)
  });
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("active_repo_full_name")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    return NextResponse.json({ error: "Unable to load active repo.", detail: profileError.message }, { status: 500 });
  }

  const thread = await getOrCreateChatThread({
    supabase,
    userId: user.id,
    repoFullName: profile?.active_repo_full_name ?? null,
    channel: "web",
    threadId: typeof body.threadId === "string" ? body.threadId : null,
    externalThreadKey: typeof body.externalThreadKey === "string" ? body.externalThreadKey : "default"
  });

  const userMessage = await appendChatMessage({
    supabase,
    userId: user.id,
    threadId: thread.id,
    role: "user",
    content: message,
    metadata: { activeRepo: profile?.active_repo_full_name ?? null }
  });

  const answer = await answerShipBrainQuestion({
    supabase,
    userId: user.id,
    userEmail: user.email,
    repoFullName: profile?.active_repo_full_name ?? null,
    threadId: thread.id,
    message,
    limit: 12
  });

  const assistantMessage = await appendChatMessage({
    supabase,
    userId: user.id,
    threadId: thread.id,
    role: "assistant",
    content: answer.reply,
    metadata: {
      activeRepo: answer.activeRepo,
      historyCount: answer.historyCount
    }
  });

  return NextResponse.json({
    ...answer,
    threadId: thread.id,
    messages: [toClientMessage(userMessage), toClientMessage(assistantMessage)]
  });
}
