import { NextResponse } from "next/server";
import { createHmac, createHash, timingSafeEqual } from "crypto";
import { updateTraceBySpec } from "@/lib/orchestrator";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { updateRepoCurrentVersion } from "@/lib/shipbrain/repo-version";

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
    .select("id, release_status, release_tag, release_sha")
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

  // Update spec status based on deployment result
  if (succeeded) {
    const specUpdate: Record<string, any> = {
      updated_at: new Date().toISOString()
    };

    if (isPreview) {
      specUpdate.preview_status = "deployed";
      if (url) specUpdate.preview_url = url;
      await db.from("specs").update(specUpdate).eq("id", spec.id);
    } else {
      // Production deployment succeeded
      // IMPORTANT: Don't overwrite specs that were rolled back
      if (spec.release_status === "rolled_back") {
        console.log(`Skipping update for rolled_back spec ${spec.id}`);
        return NextResponse.json({ ok: true, message: "Spec is rolled_back, skipping update" });
      }

      specUpdate.release_status = "deployed";
      specUpdate.deployed_at = new Date().toISOString();
      if (url) specUpdate.production_url = url;

      // Update the main spec
      await db.from("specs").update(specUpdate).eq("id", spec.id);

      // Also update all linked feature specs that were part of this release
      // Find the release spec to get its release_pr_number
      const { data: releaseSpec } = await db
        .from("specs")
        .select("release_pr_number, repo_full_name")
        .eq("id", spec.id)
        .single();

      if (releaseSpec?.release_pr_number) {
        // Update all feature specs linked to this release PR
        const { data: linkedSpecs } = await db
          .from("specs")
          .select("id")
          .eq("repo_full_name", releaseSpec.repo_full_name)
          .eq("release_pr_number", releaseSpec.release_pr_number)
          .neq("id", spec.id);

        if (linkedSpecs?.length) {
          // IMPORTANT: Don't overwrite specs that were rolled back
          await db
            .from("specs")
            .update({
              release_status: "deployed",
              deployed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq("repo_full_name", releaseSpec.repo_full_name)
            .eq("release_pr_number", releaseSpec.release_pr_number)
            .neq("id", spec.id)
            .neq("release_status", "rolled_back");

          // Also update all linked traces to production_live
          for (const linkedSpec of linkedSpecs) {
            await updateTraceBySpec(linkedSpec.id, {
              status: "production_live",
              production_deployment: { status: "deployed", url, sha, timestamp: new Date().toISOString() }
            }, {
              eventType: "deployment_succeeded",
              source: "cloudflare",
              actor: "cloudflare",
              actorType: "system",
              details: { linkedFromReleaseSpec: spec.id, releaseTag: body.releaseTag || body.release_tag }
            }).catch((err) => console.error(`[Cloudflare Deploy] Failed to update linked trace for spec ${linkedSpec.id}:`, err));
          }

          console.log(`[Cloudflare Deploy] Updated ${linkedSpecs.length} linked specs and traces for release PR #${releaseSpec.release_pr_number}`);
        }
      }

      // Update repo's current_version on successful production deployment
      const releaseTag = body.releaseTag || body.release_tag || spec.release_tag;
      if (releaseTag) {
        await updateRepoCurrentVersion(db, {
          repoFullName,
          version: releaseTag,
          sha: sha || spec.release_sha || null,
          type: "release"
        });
      }
    }
  } else if (failed) {
    const specUpdate: Record<string, any> = {
      updated_at: new Date().toISOString()
    };

    if (isPreview) {
      specUpdate.preview_status = "failed";
      await db.from("specs").update(specUpdate).eq("id", spec.id);
    } else {
      // IMPORTANT: Don't overwrite specs that were rolled back
      if (spec.release_status !== "rolled_back") {
        specUpdate.release_status = "failed";
        await db.from("specs").update(specUpdate).eq("id", spec.id);
      }
    }
  }

  await db.from("cloudflare_webhook_events").update({
    status: "processed",
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("event_id", eventId);

  return NextResponse.json({ ok: true, matched: true, specId: spec.id });
}
