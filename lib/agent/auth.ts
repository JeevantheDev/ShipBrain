import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashShipBrainApiKey } from "@/lib/shipbrain/api-keys";

export type AgentAuthResult =
  | {
      ok: true;
      supabase: ReturnType<typeof getSupabaseAdminClient>;
      userId: string;
      repoId?: string;
      repoFullName?: string;
    }
  | { ok: false; response: NextResponse };

function bearerToken(request: Request) {
  const shipbrainApiKey = request.headers.get("x-shipbrain-api-key")?.trim();
  if (shipbrainApiKey) return shipbrainApiKey;

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();

  return header.trim();
}

export async function requireAgentAuth(request: Request): Promise<AgentAuthResult> {
  const token = bearerToken(request);
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized agent request." }, { status: 401 })
    };
  }

  const supabase = getSupabaseAdminClient();
  const { data: repo, error } = await supabase
    .from("repos")
    .select("id, user_id, full_name")
    .eq("shipbrain_api_key_hash", hashShipBrainApiKey(token))
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unable to verify agent API key.", detail: error.message }, { status: 500 })
    };
  }

  if (!repo) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid ShipBrain agent API key." }, { status: 401 })
    };
  }

  return { ok: true, supabase, userId: repo.user_id, repoId: repo.id, repoFullName: repo.full_name };
}
