/**
 * ShipBrain AI Persistent Memory
 *
 * Reads and writes short-term "memory notes" stored in the ai_memory_notes table.
 * Notes are scoped per user (and optionally per repo) and injected into the AI
 * system prompt to give the AI long-term context across sessions.
 *
 * The table is optional — all functions fail gracefully if it doesn't exist yet.
 */

type SupabaseLike = {
  from: (table: string) => any;
};

export type MemoryNote = {
  key: string;
  value: string;
  category: "general" | "incident" | "release" | "convention" | "preference";
  repo_full_name?: string | null;
  updated_at: string;
};

/** Max notes to inject into the AI context per request */
const MAX_NOTES_IN_CONTEXT = 12;

/** Max character length per note value */
const MAX_NOTE_LENGTH = 300;

/**
 * Load memory notes for the AI context.
 * Returns global + repo-scoped notes, most recently updated first.
 * Silently returns [] if the table doesn't exist.
 */
export async function loadMemoryNotes(
  supabase: SupabaseLike,
  userId: string,
  repoFullName?: string | null
): Promise<MemoryNote[]> {
  try {
    let query = supabase
      .from("ai_memory_notes")
      .select("key, value, category, repo_full_name, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(MAX_NOTES_IN_CONTEXT);

    // Load global notes + repo-scoped notes together
    if (repoFullName) {
      query = query.or(`repo_full_name.is.null,repo_full_name.eq.${repoFullName}`);
    } else {
      query = query.is("repo_full_name", null);
    }

    const { data, error } = await query;
    if (error) return []; // table may not exist yet — fail gracefully
    return (data ?? []) as MemoryNote[];
  } catch {
    return [];
  }
}

/**
 * Upsert a memory note. If a note with the same key already exists for this
 * user + repo, it is overwritten (update wins).
 * Silently no-ops if the table doesn't exist.
 */
export async function upsertMemoryNote(
  supabase: SupabaseLike,
  userId: string,
  note: {
    key: string;
    value: string;
    category?: MemoryNote["category"];
    repoFullName?: string | null;
  }
): Promise<void> {
  try {
    const truncatedValue = note.value.slice(0, MAX_NOTE_LENGTH);
    await supabase.from("ai_memory_notes").upsert(
      {
        user_id: userId,
        repo_full_name: note.repoFullName ?? null,
        key: note.key,
        value: truncatedValue,
        category: note.category ?? "general",
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id,repo_full_name,key", ignoreDuplicates: false }
    );
  } catch {
    // Silently ignore — memory is best-effort
  }
}

/**
 * Delete a memory note by key.
 * Silently no-ops if the table doesn't exist.
 */
export async function deleteMemoryNote(
  supabase: SupabaseLike,
  userId: string,
  key: string,
  repoFullName?: string | null
): Promise<void> {
  try {
    let q = supabase
      .from("ai_memory_notes")
      .delete()
      .eq("user_id", userId)
      .eq("key", key);
    if (repoFullName) {
      q = q.eq("repo_full_name", repoFullName);
    } else {
      q = q.is("repo_full_name", null);
    }
    await q;
  } catch {
    // Silently ignore
  }
}

/** Category to single-letter code mapping for compact format */
const CATEGORY_CODE: Record<MemoryNote["category"], string> = {
  incident: "I",
  release: "R",
  convention: "C",
  preference: "P",
  general: "G"
};

/**
 * Format memory notes as a compact block to inject into the AI system prompt.
 * Uses abbreviated format to reduce token usage by ~30%:
 *   [I:repo] key=value  (incident, repo-scoped)
 *   [C] key=value       (convention, global)
 *
 * Returns an empty string if there are no notes.
 */
export function formatMemoryNotesForPrompt(notes: MemoryNote[]): string {
  if (!notes.length) return "";

  const lines = notes.map((n) => {
    const code = CATEGORY_CODE[n.category] ?? "G";
    // Only include repo name (not full path) for scoped notes
    const repo = n.repo_full_name?.split("/")[1];
    const scope = repo ? `:${repo}` : "";
    return `[${code}${scope}] ${n.key}=${n.value}`;
  });

  return ["## Memory", ...lines, ""].join("\n");
}
