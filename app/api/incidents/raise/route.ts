import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { repoFromBearer } from "@/lib/shipbrain/api-auth";
import { flushPendingTelegramNotifications } from "@/lib/telegram/flush";

export const runtime = "nodejs";

function normalizeSeverity(value: string) {
  const severity = value.toLowerCase();
  if (["critical", "error", "warning", "info"].includes(severity)) return severity;
  return "error";
}

export async function POST(request: Request) {
  const auth = await repoFromBearer(request);
  if (!auth.repo) return NextResponse.json({ error: auth.error }, { status: 401 });
  const body = await request.json();
  const title = String(body.title ?? "").trim();
  const source = String(body.source ?? "application").trim();
  const severity = normalizeSeverity(String(body.severity ?? "error"));
  const details = body.details && typeof body.details === "object" ? body.details : {};
  if (!title) return NextResponse.json({ error: "title is required." }, { status: 400 });

  const routingKey = process.env.PAGERDUTY_ROUTING_KEY;
  if (!routingKey) {
    return NextResponse.json({ error: "PAGERDUTY_ROUTING_KEY is not configured in ShipBrain server env." }, { status: 500 });
  }

  const dedupKey = String(body.dedupKey ?? `${auth.repo.full_name}|${source}|${title}`).toLowerCase();
  const pdResponse = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing_key: routingKey,
      event_action: "trigger",
      dedup_key: dedupKey,
      payload: {
        summary: title,
        severity,
        source,
        custom_details: {
          repo: auth.repo.full_name,
          ...details
        }
      }
    })
  });

  if (!pdResponse.ok) {
    return NextResponse.json({ error: "PagerDuty rejected the incident.", detail: await pdResponse.text() }, { status: 502 });
  }

  const pdBody = await pdResponse.json().catch(() => ({}));
  const supabase = getSupabaseAdminClient();
  const { data: incident, error } = await supabase
    .from("incidents")
    .insert({
      user_id: auth.repo.user_id,
      alert_source: "shipbrain-api",
      status: "open",
      title,
      repo_full_name: auth.repo.full_name,
      environment: String(details.environment ?? "production"),
      service: source,
      severity: severity === "error" ? "high" : severity === "warning" ? "medium" : severity === "info" ? "low" : "critical",
      external_id: pdBody.dedup_key ?? dedupKey,
      dedupe_key: dedupKey,
      raw_logs: JSON.stringify(details, null, 2),
      payload: { title, source, severity, details, pagerduty: pdBody },
      updated_at: new Date().toISOString()
    })
    .select("id, title, status, repo_full_name, severity, created_at")
    .single();

  await supabase.from("approval_events").insert({
    entity_type: "repo",
    entity_id: auth.repo.id,
    action: "INCIDENT_RAISED",
    actor_id: auth.repo.user_id,
    note: title,
    metadata: { source, severity, dedupKey }
  });

  if (error) return NextResponse.json({ error: "PagerDuty accepted the event, but ShipBrain could not save the incident.", detail: error.message }, { status: 500 });
  await flushPendingTelegramNotifications().catch((error) => console.error("telegram notification flush failed", error));
  return NextResponse.json({ ok: true, incident });
}
