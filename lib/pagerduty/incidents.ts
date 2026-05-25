type PagerDutyIncidentAction = {
  incidentId: string;
  fromEmail?: string | null;
  note?: string | null;
};

type PagerDutyResult = {
  ok: boolean;
  detail?: string;
  skipped?: boolean;
};

function getPagerDutyApiBase() {
  return (process.env.PAGERDUTY_API_BASE ?? "https://api.pagerduty.com").replace(/\/$/, "");
}

function getPagerDutyHeaders(fromEmail?: string | null) {
  const token = process.env.PAGERDUTY_API_TOKEN;
  if (!token) {
    return null;
  }

  return {
    Accept: "application/vnd.pagerduty+json;version=2",
    Authorization: `Token token=${token}`,
    "Content-Type": "application/json",
    ...(fromEmail ? { From: fromEmail } : {})
  };
}

async function readPagerDutyError(response: Response) {
  try {
    const body = await response.json();
    return body?.error?.message ?? body?.message ?? JSON.stringify(body);
  } catch {
    return response.statusText;
  }
}

function normalizePagerDutyDetail(detail?: string) {
  if (!detail) return "The configured alert provider rejected the incident update.";
  if (/Requester User Not Found/i.test(detail)) {
    return "The configured alert provider could not find the requester identity. Update the ShipBrain alert provider email setting, then retry sync.";
  }
  if (/Invalid Input Provided/i.test(detail)) {
    return "The configured alert provider rejected the resolve payload. ShipBrain recorded the hotfix; retry sync after confirming the incident is still open and the provider token can update incidents.";
  }
  return detail;
}

export async function addPagerDutyIncidentNote({
  incidentId,
  fromEmail,
  note
}: PagerDutyIncidentAction): Promise<PagerDutyResult> {
  if (!incidentId || !note?.trim()) {
    return { ok: true, skipped: true };
  }

  const headers = getPagerDutyHeaders(fromEmail);
  if (!headers) {
    return { ok: true, skipped: true, detail: "Alert provider API token is not configured." };
  }

  const response = await fetch(`${getPagerDutyApiBase()}/incidents/${encodeURIComponent(incidentId)}/notes`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      note: {
        content: note.trim()
      }
    })
  });

  if (!response.ok) {
    return { ok: false, detail: normalizePagerDutyDetail(await readPagerDutyError(response)) };
  }

  return { ok: true };
}

export async function resolvePagerDutyIncident({
  incidentId,
  fromEmail,
  note
}: PagerDutyIncidentAction): Promise<PagerDutyResult> {
  if (!incidentId) {
    return { ok: true, skipped: true };
  }

  const headers = getPagerDutyHeaders(fromEmail);
  if (!headers) {
    return { ok: true, skipped: true, detail: "Alert provider API token is not configured." };
  }

  if (note?.trim()) {
    await addPagerDutyIncidentNote({ incidentId, fromEmail, note });
    // Notes are useful context, but they should not block the actual incident resolve.
    // Some PagerDuty accounts reject notes for resolved/restricted incidents while still allowing status updates.
  }

  const response = await fetch(`${getPagerDutyApiBase()}/incidents/${encodeURIComponent(incidentId)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      incident: {
        type: "incident",
        status: "resolved"
      }
    })
  });

  if (!response.ok) {
    return { ok: false, detail: normalizePagerDutyDetail(await readPagerDutyError(response)) };
  }

  return { ok: true };
}
