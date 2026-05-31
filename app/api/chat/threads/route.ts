import { NextRequest, NextResponse } from "next/server";
import {
  listChatThreads,
  saveThreadOnClose,
  deleteThread,
  getOrCreateChatThread
} from "@/lib/ai/chat-store";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const channel = searchParams.get("channel") as "web" | "telegram" | null;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "5", 10), 10);

  try {
    const threads = await listChatThreads({
      supabase,
      userId: user.id,
      channel: channel ?? undefined,
      limit
    });

    // Get message counts for each thread
    const threadsWithCounts = await Promise.all(
      threads.map(async (thread) => {
        const { count } = await supabase
          .from("chat_messages")
          .select("*", { count: "exact", head: true })
          .eq("thread_id", thread.id);

        const { data: lastMsg } = await supabase
          .from("chat_messages")
          .select("content, role")
          .eq("thread_id", thread.id)
          .order("created_at", { ascending: false })
          .limit(1);

        return {
          ...thread,
          messageCount: count ?? 0,
          lastMessage: lastMsg?.[0]?.content?.slice(0, 80) ?? null,
          lastMessageRole: lastMsg?.[0]?.role ?? null
        };
      })
    );

    return NextResponse.json(threadsWithCounts);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load threads";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "create");

  try {
    if (action === "create") {
      const { data: profile } = await supabase
        .from("profiles")
        .select("active_repo_full_name")
        .eq("id", user.id)
        .maybeSingle();

      const thread = await getOrCreateChatThread({
        supabase,
        userId: user.id,
        repoFullName: profile?.active_repo_full_name ?? null,
        channel: "web",
        title: body.title ?? "New conversation"
      });

      return NextResponse.json({ ok: true, thread });
    }

    if (action === "save" && body.threadId) {
      await saveThreadOnClose({
        supabase,
        userId: user.id,
        threadId: body.threadId,
        title: body.title
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "delete" && body.threadId) {
      await deleteThread({
        supabase,
        userId: user.id,
        threadId: body.threadId
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
