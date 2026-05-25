import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashShipBrainApiKey } from "@/lib/shipbrain/api-keys";

export async function repoFromBearer(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return { error: "Missing SHIPBRAIN_API_KEY bearer token.", repo: null };

  const supabase = getSupabaseAdminClient();
  const { data: repo, error } = await supabase
    .from("repos")
    .select("id, user_id, full_name, shipbrain_api_key_hash")
    .eq("shipbrain_api_key_hash", hashShipBrainApiKey(token))
    .maybeSingle();

  if (error) return { error: error.message, repo: null };
  if (!repo) return { error: "Invalid SHIPBRAIN_API_KEY.", repo: null };
  return { repo, error: null };
}
