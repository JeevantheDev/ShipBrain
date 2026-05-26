import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { verifyCloudflareToken, verifyCloudflareProject } from "@/lib/cloudflare/client";

export const runtime = "nodejs";

async function requireUser() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return user;
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const type = String(body.type ?? "");

  if (type === "cloudflare_token") {
    const token = String(body.cloudflareApiToken ?? "").trim();
    if (!token) return NextResponse.json({ error: "Paste a Cloudflare API token first." }, { status: 400 });

    const isValid = await verifyCloudflareToken(token);
    if (!isValid) {
      return NextResponse.json(
        { error: "Cloudflare rejected this token.", detail: "Make sure it has not expired and has the correct permissions (Cloudflare Pages:Edit)." },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (type === "cloudflare_project") {
    const token = String(body.cloudflareApiToken ?? "").trim();
    const accountId = String(body.cloudflareAccountId ?? "").trim();
    const projectName = String(body.cloudflareProjectName ?? "").trim();

    if (!token || !accountId || !projectName) {
      return NextResponse.json({ error: "Cloudflare token, account ID, and project name are required." }, { status: 400 });
    }

    const result = await verifyCloudflareProject({ apiToken: token, accountId, projectName });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? "Cloudflare project verification failed.", detail: "Create the Pages project in your Cloudflare dashboard first." },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      projectName,
      projectUrl: result.projectUrl
    });
  }

  if (type === "pagerduty") {
    const routingKey = String(body.pagerDutyRoutingKey ?? "").trim();
    if (!routingKey) return NextResponse.json({ error: "Paste the PagerDuty Events API v2 routing key first." }, { status: 400 });
    const dedupKey = `shipbrain-verify-${Date.now()}`;
    const trigger = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: routingKey,
        event_action: "trigger",
        dedup_key: dedupKey,
        payload: {
          summary: "ShipBrain integration verification",
          severity: "info",
          source: "shipbrain"
        }
      })
    });
    if (!trigger.ok) {
      return NextResponse.json(
        { error: "Rejected by PagerDuty.", detail: "Check you copied the Integration Key from Events API V2, not the REST API key from Account Settings." },
        { status: 400 }
      );
    }
    await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routing_key: routingKey, event_action: "resolve", dedup_key: dedupKey })
    }).catch(() => undefined);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `Unknown verification type: ${type}` }, { status: 400 });
}
