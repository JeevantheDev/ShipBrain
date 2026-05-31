import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShipBrainApiKey } from "@/lib/shipbrain/api-keys";
import { flushPendingTelegramNotifications } from "@/lib/telegram/flush";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-shipbrain-incident-secret, authorization"
};

type IncidentPayload = {
  source?: string;
  repo?: string;
  environment?: string;
  service?: string;
  severity?: string;
  title?: string;
  logs?: string;
  branch?: string;
  commit?: string;
  releaseVersion?: string;
  incidentId?: string;
};

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizePagerDutyPayload(body: any): IncidentPayload | null {
  const event = body?.event;
  const data = event?.data;
  const incident = data?.incident ?? data;
  const customDetails =
    incident?.body?.details ??
    incident?.custom_details ??
    incident?.payload?.custom_details ??
    data?.custom_details ??
    data?.payload?.custom_details ??
    body?.payload?.custom_details ??
    {};
  const title = firstString(
    incident?.title,
    incident?.summary,
    incident?.payload?.summary,
    data?.title,
    data?.summary,
    data?.payload?.summary,
    body?.payload?.summary
  );

  if (!event || !title) return null;

  return {
    source: "pagerduty",
    repo: firstString(customDetails.repo, customDetails.repository, incident?.payload?.source, data?.payload?.source, body?.payload?.source),
    environment: firstString(customDetails.environment, incident?.payload?.group, data?.payload?.group, body?.payload?.group) ?? "sandbox",
    service: firstString(customDetails.service, incident?.payload?.component, data?.payload?.component, body?.payload?.component, incident?.service?.summary) ?? "unknown-service",
    severity: firstString(customDetails.severity, incident?.payload?.severity, data?.payload?.severity, body?.payload?.severity, incident?.urgency) ?? "high",
    title,
    logs: firstString(customDetails.logs, customDetails.error, incident?.description, data?.description) ?? JSON.stringify(body, null, 2),
    branch: firstString(customDetails.branch),
    commit: firstString(customDetails.commit),
    releaseVersion: firstString(customDetails.releaseVersion, customDetails.release_version),
    incidentId: firstString(incident?.id, data?.id, body?.dedup_key)
  };
}

function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init?.headers ?? {})
    }
  });
}

function normalizeSeverity(value: string) {
  const severity = value.trim().toLowerCase();
  if (["critical", "high", "medium", "low"].includes(severity)) return severity;
  if (["error", "urgent"].includes(severity)) return "high";
  if (["warning", "warn"].includes(severity)) return "medium";
  if (["info", "informational"].includes(severity)) return "low";
  return "high";
}

function incidentDedupeKey(input: {
  repo: string;
  environment: string;
  service: string;
  title: string;
  releaseVersion: string;
}) {
  const titleRelease = input.title.match(/\b(?:cart|hotfix|shipbrain)-v\d{4}\.\d{2}\.\d{2}(?:[-\w.]*)?\b/i)?.[0] ?? "";
  const release = input.releaseVersion || titleRelease || "unversioned";
  return [
    input.repo,
    input.environment,
    input.service,
    release,
    input.title
  ]
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  const supabase = getSupabaseAdminClient();

  // Support both legacy secret header and Bearer token authentication
  const configuredSecret = process.env.INCIDENT_WEBHOOK_SECRET;
  const authHeader = request.headers.get("authorization");
  const apiKey = authHeader?.replace(/^Bearer\s+/i, "");
  const legacySecret = request.headers.get("x-shipbrain-incident-secret");

  let authenticated = false;
  let authenticatedUserId: string | null = null;

  // Try Bearer token first (preferred for GitHub Actions)
  if (apiKey) {
    const keyVerification = await verifyShipBrainApiKey(apiKey, supabase);
    if (keyVerification.valid && keyVerification.userId) {
      authenticated = true;
      authenticatedUserId = keyVerification.userId;
    }
  }

  // Fall back to legacy secret header
  if (!authenticated && configuredSecret && legacySecret === configuredSecret) {
    authenticated = true;
  }

  // If neither authentication method works, reject
  if (!authenticated && (configuredSecret || apiKey)) {
    return json({ error: "Invalid authentication" }, { status: 401 });
  }

  const rawBody = await request.json();
  const body = normalizePagerDutyPayload(rawBody) ?? (rawBody as IncidentPayload);
  let repo = String(body.repo ?? "").trim();
  let repoConnection: { user_id: string; full_name?: string } | null = null;

  // If authenticated via API key, use that user
  if (authenticatedUserId) {
    if (repo) {
      const { data } = await supabase
        .from("repos")
        .select("user_id, full_name")
        .eq("full_name", repo)
        .eq("user_id", authenticatedUserId)
        .maybeSingle();
      repoConnection = data ?? { user_id: authenticatedUserId, full_name: repo };
    } else {
      const { data } = await supabase
        .from("repos")
        .select("user_id, full_name")
        .eq("user_id", authenticatedUserId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      repoConnection = data ?? { user_id: authenticatedUserId };
      repo = data?.full_name ?? repo;
    }
  } else if (repo) {
    const { data } = await supabase
      .from("repos")
      .select("user_id, full_name")
      .eq("full_name", repo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    repoConnection = data;
  } else {
    const { data } = await supabase
      .from("repos")
      .select("user_id, full_name")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    repoConnection = data;
    repo = data?.full_name ?? "";
  }

  const title = String(body.title ?? "").trim();
  const logs = String(body.logs ?? "").trim();
  const service = String(body.service ?? "").trim();
  const severity = normalizeSeverity(String(body.severity ?? "medium"));
  const environment = String(body.environment ?? "sandbox").trim();
  const releaseVersion = String(body.releaseVersion ?? "").trim();
  const dedupeKey = incidentDedupeKey({ repo, environment, service, title, releaseVersion });

  const missing = [
    !repo ? "repo" : "",
    !title ? "title" : "",
    !logs ? "logs" : "",
    !service ? "service" : ""
  ].filter(Boolean);

  if (missing.length) {
    return json({ error: `Missing required fields: ${missing.join(", ")}` }, { status: 400 });
  }

  if (!["low", "medium", "high", "critical"].includes(severity)) {
    return json({ error: "severity must be one of low, medium, high, critical" }, { status: 400 });
  }

  if (!repoConnection?.user_id) {
    return json(
      { error: "Repository is not connected in ShipBrain. Connect this repo during onboarding before sending incidents." },
      { status: 409 }
    );
  }

  const externalId = body.incidentId ?? `sandbox-${Date.now()}`;

  // First, check for existing incident by external_id (for workflow-based incidents)
  // This prevents duplicates when the same workflow triggers multiple times
  let existingIncident: { id: string; status: string; payload: any } | null = null;
  let foundByExternalId = false;

  if (body.incidentId) {
    // Check for any incident with this external_id (including resolved ones for reopening)
    const { data: byExternalId } = await supabase
      .from("incidents")
      .select("id, status, payload")
      .eq("user_id", repoConnection.user_id)
      .eq("external_id", body.incidentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (byExternalId) {
      existingIncident = byExternalId;
      foundByExternalId = true;
    }
  }

  // If not found by external_id, check by dedupe_key (only active incidents - not resolved or rejected)
  if (!existingIncident) {
    const { data: byDedupeKey } = await supabase
      .from("incidents")
      .select("id, status, payload")
      .eq("user_id", repoConnection.user_id)
      .eq("dedupe_key", dedupeKey)
      .not("status", "in", "(resolved,rejected)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (byDedupeKey) {
      existingIncident = byDedupeKey;
    }
  }

  if (existingIncident?.id) {
    // Reopen if the incident was resolved or rejected (terminal states)
    const isTerminalState = existingIncident.status === "resolved" || existingIncident.status === "rejected";
    const { data, error } = await supabase
      .from("incidents")
      .update({
        alert_source: isTerminalState ? body.source ?? "pagerduty-sandbox" : undefined,
        status: isTerminalState ? "open" : existingIncident.status,
        branch: body.branch ?? null,
        commit_sha: body.commit ?? null,
        release_version: releaseVersion || null,
        external_id: externalId,
        raw_logs: logs,
        payload: {
          ...(typeof existingIncident.payload === "object" && existingIncident.payload ? existingIncident.payload : {}),
          latest: body,
          sources: Array.from(new Set([
            ...(Array.isArray((existingIncident.payload as any)?.sources) ? (existingIncident.payload as any).sources : []),
            body.source ?? "pagerduty-sandbox"
          ]))
        },
        updated_at: new Date().toISOString()
      })
      .eq("id", existingIncident.id)
      .select("id, title, alert_source, status, repo_full_name, environment, service, severity, release_version, raw_logs, created_at")
      .single();

    if (error) return json({ error: "Unable to update incident from webhook.", detail: error.message }, { status: 500 });
    await flushPendingTelegramNotifications().catch((error) => console.error("telegram notification flush failed", error));
    return json({ ok: true, deduped: true, incident: data }, { status: 200 });
  }

  const { data, error } = await supabase
    .from("incidents")
    .insert({
      user_id: repoConnection.user_id,
      alert_source: body.source ?? "pagerduty-sandbox",
      status: "open",
      title,
      repo_full_name: repo,
      environment,
      service,
      severity,
      branch: body.branch ?? null,
      commit_sha: body.commit ?? null,
      release_version: releaseVersion || null,
      external_id: externalId,
      dedupe_key: dedupeKey,
      raw_logs: logs,
      payload: body,
      updated_at: new Date().toISOString()
    })
    .select("id, title, alert_source, status, repo_full_name, environment, service, severity, release_version, raw_logs, created_at")
    .single();

  if (error) {
    return json({ error: "Unable to create incident from webhook.", detail: error.message }, { status: 500 });
  }

  await flushPendingTelegramNotifications().catch((error) => console.error("telegram notification flush failed", error));
  return json({ ok: true, incident: data }, { status: 201 });
}
