import { appendChatMessage, getOrCreateChatThread } from "@/lib/ai/chat-store";
import { streamShipBrainQuestion } from "@/lib/ai/shipbrain-chat";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { ChatAction } from "@/lib/ai/chat-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function event(type: string, data: unknown) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chunkText(chunk: any) {
  const content = chunk?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .join("");
  }
  return "";
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response(event("error", { error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
  }

  const body = await request.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) {
    return new Response(event("error", { error: "message is required" }), {
      status: 400,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
  }

  // Get pending action from client if any
  const pendingAction: ChatAction | null = body.pendingAction ?? null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("active_repo_full_name")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    return new Response(event("error", { error: "Unable to load active repo.", detail: profileError.message }), {
      status: 500,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let threadId = "";
      let fullText = "";
      try {
        const thread = await getOrCreateChatThread({
          supabase,
          userId: user.id,
          repoFullName: profile?.active_repo_full_name ?? null,
          channel: "web",
          threadId: typeof body.threadId === "string" ? body.threadId : null,
          externalThreadKey: typeof body.externalThreadKey === "string" ? body.externalThreadKey : "default"
        });
        threadId = thread.id;

        const userMessage = await appendChatMessage({
          supabase,
          userId: user.id,
          threadId,
          role: "user",
          content: message,
          metadata: { activeRepo: profile?.active_repo_full_name ?? null, streamed: true }
        });

        controller.enqueue(encoder.encode(event("meta", {
          threadId,
          userMessage: {
            id: userMessage.id,
            role: userMessage.role,
            content: userMessage.content,
            createdAt: userMessage.created_at
          }
        })));

        const answer = await streamShipBrainQuestion({
          supabase,
          userId: user.id,
          userEmail: user.email,
          repoFullName: profile?.active_repo_full_name ?? null,
          threadId,
          message,
          limit: 20, // #3: match the raised history window
          pendingAction,
          quickPromptId: typeof body.quickPromptId === "string" ? body.quickPromptId : null
        });

        // Send context and action state
        controller.enqueue(encoder.encode(event("context", {
          activeRepo: answer.context.activeRepo,
          historyCount: answer.history.length,
          action: answer.action ?? null,
          responseSource: answer.responseSource
        })));

        for await (const chunk of answer.stream) {
          const delta = chunkText(chunk);
          if (!delta) continue;
          fullText += delta;
          controller.enqueue(encoder.encode(event("delta", { delta })));
        }

        const assistantMessage = await appendChatMessage({
          supabase,
          userId: user.id,
          threadId,
          role: "assistant",
          content: fullText,
          metadata: {
            activeRepo: answer.context.activeRepo,
            historyCount: answer.history.length,
            streamed: true,
            responseSource: answer.responseSource,
            action: answer.action ?? null,
            // #6: Persist read tool result so follow-up turns can reference it
            ...(answer.action?.type && answer.action?.result
              ? { readToolName: answer.action.type, readToolResult: answer.action.result }
              : {})
          }
        });

        controller.enqueue(encoder.encode(event("done", {
          threadId,
          assistantMessage: {
            id: assistantMessage.id,
            role: assistantMessage.role,
            content: assistantMessage.content,
            createdAt: assistantMessage.created_at,
            responseSource: answer.responseSource
          },
          action: answer.action ?? null,
          responseSource: answer.responseSource
        })));
      } catch (error) {
        controller.enqueue(encoder.encode(event("error", {
          error: error instanceof Error ? error.message : "ShipBrain AI stream failed."
        })));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive"
    }
  });
}
