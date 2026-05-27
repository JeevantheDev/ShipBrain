import { NextResponse } from "next/server";
import { createHmac, createHash, timingSafeEqual } from "crypto";
import { updateTraceBySpec } from "@/lib/orchestrator";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyCloudflareSecret(request: Request, payload: string) {
  const expected = process.env.CLOUDFLARE_WEBHOOK_SECRET;
  if (!expected) return true;

  const timestamp = request.headers.get("x-shipbrain-cloudflare-timestamp");
  const signature = request.headers.get("x-shipbrain-cloudflare-signature");
  if (timestamp && signature) {
    const ageMs = Math.abs(Date.now() - Date.parse(timestamp));
    if (!Number.isFinite(ageMs) || ageMs > 5 * 60 * 1000) return false;
    const expectedSignature = `sha256=${createHmac("sha256", expected).update(`${timestamp}.${payload}`).digest("hex")}`;
    return safeEqual(signature, expectedSignature);
  }

  return request.headers.get("x-shipbrain-cloudflare-secret") === expected;
}

export async function POST(request: Request) {
  const payload = await request.text();
  if (!verifyCloudflareSecret(request, payload)) {
    return NextResponse.json({ error: "Invalid Cloudflare webhook secret." }, { status: 401 });
  }

  const body = JSON.parse(payload || "{}");
  const repoFullName = body.repoFullName ?? body.repo ?? body.project?.repo_full_name ?? null;
  const sha = body.sha ?? body.commit_hash ?? body.deployment?.commit_hash ?? null;
  const environment = body.environment ?? body.deployment?.environment ?? "production";
  const status = body.status ?? body.deployment?.status ?? body.event ?? "created";
  const url = body.url ?? body.deployment?.url ?? body.deployment?.deployment_url ?? null;
  const eventId =
    body.id ??
    body.event_id ??
    body.deployment?.id ??
    `${repoFullName ?? "unknown"}:${sha ?? "no-sha"}:${environment}:${status}:${url ?? "no-url"}`;
  const payloadHash = createHash("sha256").update(payload).digest("hex");

  if (!repoFullName) return NextResponse.json({ error: "repoFullName is required." }, { status: 400 });

  const db = getSupabaseAdminClient();
  const { data: existingEvent } = await db
    .from("cloudflare_webhook_events")
    .select("status, payload_hash")
    .eq("event_id", eventId)
    .maybeSingle();
  if (existingEvent?.status === "processed" && existingEvent.payload_hash === payloadHash) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  await db.from("cloudflare_webhook_events").upsert({
    event_id: eventId,
    repo_full_name: repoFullName,
    status: "processing",
    payload_hash: payloadHash,
    updated_at: new Date().toISOString()
  }, { onConflict: "event_id" });

  let query = db
    .from("specs")
    .select("id")
    .eq("repo_full_name", repoFullName)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (sha) {
    query = query.or(`release_sha.eq.${sha},merge_sha.eq.${sha},feature_head_sha.eq.${sha}`);
  } else {
    query = query.in("release_status", ["deploying", "pending_deploy"]);
  }
  const { data: spec } = await query.maybeSingle();

  if (!spec?.id) {
    await db.from("cloudflare_webhook_events").update({
      status: "processed",
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("event_id", eventId);
    return NextResponse.json({ ok: true, matched: false });
  }

  const succeeded = /success|succeeded|ready|active/i.test(String(status));
  const failed = /fail|error|canceled|cancelled/i.test(String(status));
  const isPreview = environment === "preview" || environment === "develop";

  await updateTraceBySpec(spec.id, {
    status: failed ? "failed" : succeeded ? (isPreview ? "preview_live" : "production_live") : (isPreview ? "merged_develop" : "merged_main"),
    ...(isPreview
      ? { preview_deployment: { status, url, sha, timestamp: new Date().toISOString() } }
      : { production_deployment: { status, url, sha, timestamp: new Date().toISOString() } })
  }, {
    eventType: failed ? "deployment_failed" : succeeded ? "deployment_succeeded" : "deployment_started",
    source: "cloudflare",
    actor: "cloudflare",
    actorType: "system",
    details: body
  });

  await db.from("cloudflare_webhook_events").update({
    status: "processed",
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("event_id", eventId);

  return NextResponse.json({ ok: true, matched: true, specId: spec.id });
}
