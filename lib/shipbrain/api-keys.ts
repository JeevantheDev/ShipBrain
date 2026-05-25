import { createHash, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function generateShipBrainApiKey() {
  return `sb_live_${randomBytes(24).toString("base64url")}`;
}

export function hashShipBrainApiKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function lastFour(value: string) {
  return value.slice(-4);
}

export type ApiKeyVerification = {
  valid: boolean;
  userId?: string;
  repoId?: string;
  repoFullName?: string;
};

/**
 * Verify a ShipBrain API key and return the associated user/repo info
 */
export async function verifyShipBrainApiKey(
  apiKey: string,
  supabase: SupabaseClient
): Promise<ApiKeyVerification> {
  if (!apiKey || !apiKey.startsWith("sb_live_")) {
    return { valid: false };
  }

  const hash = hashShipBrainApiKey(apiKey);

  const { data: repo, error } = await supabase
    .from("repos")
    .select("id, user_id, full_name")
    .eq("shipbrain_api_key_hash", hash)
    .maybeSingle();

  if (error || !repo) {
    return { valid: false };
  }

  return {
    valid: true,
    userId: repo.user_id,
    repoId: repo.id,
    repoFullName: repo.full_name
  };
}
