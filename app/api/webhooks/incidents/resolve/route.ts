import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShipBrainApiKey } from "@/lib/shipbrain/api-keys";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization"
};

function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init?.headers ?? {})
    }
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/**
 * Auto-resolve endpoint for ShipBrain incidents
 * Called by GitHub Actions when a previously failed workflow succeeds
 */
export async function POST(request: Request) {
  // Verify API key from Authorization header
  const authHeader = request.headers.get("authorization");
  const apiKey = authHeader?.replace(/^Bearer\s+/i, "");

  if (!apiKey) {
    return json({ error: "Authorization header required" }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();

  // Verify the API key and get the associated repo
  const keyVerification = await verifyShipBrainApiKey(apiKey, supabase);
  if (!keyVerification.valid) {
    return json({ error: "Invalid API key" }, { status: 401 });
  }

  const body = await request.json();
  const incidentId = String(body.incidentId ?? "").trim();
  const repo = String(body.repo ?? "").trim();
  const resolution = String(body.resolution ?? "Auto-resolved by workflow success").trim();

  if (!incidentId) {
    return json({ error: "incidentId is required" }, { status: 400 });
  }

  // Find the incident by external_id
  const { data: incident, error: findError } = await supabase
    .from("incidents")
    .select("id, status, external_id")
    .eq("external_id", incidentId)
    .maybeSingle();

  if (findError) {
    return json({ error: "Database error", detail: findError.message }, { status: 500 });
  }

  if (!incident) {
    // No incident found - this is normal if no failure occurred
    return json({ ok: true, message: "No matching incident found", skipped: true });
  }

  if (incident.status === "resolved") {
    return json({ ok: true, message: "Incident already resolved", skipped: true });
  }

  // Update the incident to resolved
  const { error: updateError } = await supabase
    .from("incidents")
    .update({
      status: "resolved",
      resolution_note: resolution,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", incident.id);

  if (updateError) {
    return json({ error: "Failed to resolve incident", detail: updateError.message }, { status: 500 });
  }

  return json({
    ok: true,
    incidentId: incident.id,
    message: "Incident auto-resolved"
  });
}
