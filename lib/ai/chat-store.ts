type SupabaseLike = {
  from: (table: string) => any;
};

export type StoredChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  metadata?: Record<string, unknown>;
};

export async function getOrCreateChatThread(input: {
  supabase: SupabaseLike;
  userId: string;
  repoFullName?: string | null;
  channel?: "web" | "telegram";
  externalThreadKey?: string | null;
  threadId?: string | null;
  title?: string;
}) {
  if (input.threadId) {
    const { data, error } = await input.supabase
      .from("chat_threads")
      .select("*")
      .eq("id", input.threadId)
      .eq("user_id", input.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
  }

  if (input.externalThreadKey) {
    const { data, error } = await input.supabase
      .from("chat_threads")
      .select("*")
      .eq("user_id", input.userId)
      .eq("channel", input.channel ?? "web")
      .eq("external_thread_key", input.externalThreadKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
  }

  const { data, error } = await input.supabase
    .from("chat_threads")
    .insert({
      user_id: input.userId,
      repo_full_name: input.repoFullName ?? null,
      channel: input.channel ?? "web",
      external_thread_key: input.externalThreadKey ?? null,
      title: input.title ?? "ShipBrain chat"
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listChatMessages(input: {
  supabase: SupabaseLike;
  userId: string;
  threadId: string;
  limit?: number;
}) {
  const limit = input.limit ?? 20;
  const { data, error } = await input.supabase
    .from("chat_messages")
    .select("id, role, content, metadata, created_at")
    .eq("user_id", input.userId)
    .eq("thread_id", input.threadId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as StoredChatMessage[]).reverse();
}

export async function appendChatMessage(input: {
  supabase: SupabaseLike;
  userId: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
}) {
  const { data, error } = await input.supabase
    .from("chat_messages")
    .insert({
      thread_id: input.threadId,
      user_id: input.userId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {}
    })
    .select("id, role, content, metadata, created_at")
    .single();
  if (error) throw new Error(error.message);

  await input.supabase
    .from("chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", input.threadId)
    .eq("user_id", input.userId);

  return data as StoredChatMessage;
}

export type ChatThread = {
  id: string;
  user_id: string;
  repo_full_name?: string | null;
  channel: "web" | "telegram";
  title: string;
  external_thread_key?: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message?: string | null;
};

export async function listChatThreads(input: {
  supabase: SupabaseLike;
  userId: string;
  channel?: "web" | "telegram";
  limit?: number;
}) {
  const limit = input.limit ?? 5;
  let query = input.supabase
    .from("chat_threads")
    .select("*")
    .eq("user_id", input.userId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (input.channel) {
    query = query.eq("channel", input.channel);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ChatThread[];
}

export async function updateThreadTitle(input: {
  supabase: SupabaseLike;
  userId: string;
  threadId: string;
  title: string;
}) {
  const { error } = await input.supabase
    .from("chat_threads")
    .update({ title: input.title, updated_at: new Date().toISOString() })
    .eq("id", input.threadId)
    .eq("user_id", input.userId);
  if (error) throw new Error(error.message);
}

export async function saveThreadOnClose(input: {
  supabase: SupabaseLike;
  userId: string;
  threadId: string;
  title?: string;
}) {
  // Get the first user message to use as title if not provided
  let title = input.title;
  if (!title) {
    const { data: messages } = await input.supabase
      .from("chat_messages")
      .select("content")
      .eq("thread_id", input.threadId)
      .eq("role", "user")
      .order("created_at", { ascending: true })
      .limit(1);

    if (messages?.[0]?.content) {
      title = messages[0].content.slice(0, 60) + (messages[0].content.length > 60 ? "..." : "");
    }
  }

  if (title) {
    await input.supabase
      .from("chat_threads")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", input.threadId)
      .eq("user_id", input.userId);
  }

  // Enforce max 5 threads by deleting oldest ones
  await enforceMaxThreads({ supabase: input.supabase, userId: input.userId, maxThreads: 5 });
}

export async function enforceMaxThreads(input: {
  supabase: SupabaseLike;
  userId: string;
  maxThreads?: number;
  channel?: "web" | "telegram";
}) {
  const maxThreads = input.maxThreads ?? 5;

  let query = input.supabase
    .from("chat_threads")
    .select("id, updated_at")
    .eq("user_id", input.userId)
    .order("updated_at", { ascending: false });

  if (input.channel) {
    query = query.eq("channel", input.channel);
  }

  const { data: threads, error } = await query;
  if (error) throw new Error(error.message);

  if (threads && threads.length > maxThreads) {
    const threadsToDelete = threads.slice(maxThreads);
    const idsToDelete = threadsToDelete.map((t: { id: string }) => t.id);

    // Delete messages first
    await input.supabase
      .from("chat_messages")
      .delete()
      .in("thread_id", idsToDelete);

    // Then delete threads
    await input.supabase
      .from("chat_threads")
      .delete()
      .in("id", idsToDelete);
  }
}

export async function deleteThread(input: {
  supabase: SupabaseLike;
  userId: string;
  threadId: string;
}) {
  // Delete messages first
  await input.supabase
    .from("chat_messages")
    .delete()
    .eq("thread_id", input.threadId);

  // Then delete thread
  const { error } = await input.supabase
    .from("chat_threads")
    .delete()
    .eq("id", input.threadId)
    .eq("user_id", input.userId);

  if (error) throw new Error(error.message);
}

export async function getThreadWithMessageCount(input: {
  supabase: SupabaseLike;
  userId: string;
  threadId: string;
}) {
  const { data: thread, error } = await input.supabase
    .from("chat_threads")
    .select("*")
    .eq("id", input.threadId)
    .eq("user_id", input.userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!thread) return null;

  const { count } = await input.supabase
    .from("chat_messages")
    .select("*", { count: "exact", head: true })
    .eq("thread_id", input.threadId);

  const { data: lastMsg } = await input.supabase
    .from("chat_messages")
    .select("content")
    .eq("thread_id", input.threadId)
    .order("created_at", { ascending: false })
    .limit(1);

  return {
    ...thread,
    message_count: count ?? 0,
    last_message: lastMsg?.[0]?.content?.slice(0, 100) ?? null
  } as ChatThread;
}
