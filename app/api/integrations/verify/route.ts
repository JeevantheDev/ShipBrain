import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function requireUser() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return user;
}

async function readError(response: Response) {
  try {
    const body = await response.json();
    return body?.error?.message ?? body?.message ?? JSON.stringify(body);
  } catch {
    return response.statusText;
  }
}

function vercelSettingsUrl(project: any, projectId: string) {
  const ownerSlug = project?.account?.slug ?? project?.owner?.slug ?? project?.owner?.username ?? project?.account?.name ?? "";
  const projectName = project?.name ?? "";
  if (ownerSlug && projectName) {
    return `https://vercel.com/${ownerSlug}/${projectName}/settings/environment-variables`;
  }
  return "https://vercel.com/dashboard";
}

function vercelProjectAccountId(project: any) {
  return project?.accountId ?? project?.account?.id ?? project?.owner?.id ?? project?.ownerId ?? null;
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const type = String(body.type ?? "");

  if (type === "vercel_token") {
    const token = String(body.vercelToken ?? "").trim();
    if (!token) return NextResponse.json({ error: "Paste a Vercel token first." }, { status: 400 });
    const response = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: "Vercel rejected this token.", detail: "Make sure it has not expired and belongs to a member of the project's team." },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (type === "vercel_project") {
    const token = String(body.vercelToken ?? "").trim();
    const orgId = String(body.vercelOrgId ?? "").trim();
    const projectId = String(body.vercelProjectId ?? "").trim();
    if (!token || !orgId || !projectId) return NextResponse.json({ error: "Vercel token, org ID, and project ID are required." }, { status: 400 });
    const teamScopedUrl = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(orgId)}`;
    let response = await fetch(teamScopedUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.status === 404) {
      response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    }
    if (!response.ok) {
      return NextResponse.json(
        { error: "Vercel could not find this project ID.", detail: "Check you copied it from the correct project's Settings -> General page." },
        { status: 400 }
      );
    }
    const project = await response.json().catch(() => null);
    const accountId = vercelProjectAccountId(project);
    if (accountId && accountId !== orgId) {
      return NextResponse.json(
        {
          error: "Vercel project does not belong to this org/account ID.",
          detail: "Copy VERCEL_ORG_ID from the same Vercel project Settings -> General page as the VERCEL_PROJECT_ID."
        },
        { status: 400 }
      );
    }
    return NextResponse.json({
      ok: true,
      projectName: project?.name ?? null,
      accountId,
      settingsUrl: vercelSettingsUrl(project, projectId)
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

  return NextResponse.json({ error: `Unknown verification type: ${type}`, detail: await readError(new Response(null, { status: 400, statusText: "Bad request" })) }, { status: 400 });
}
