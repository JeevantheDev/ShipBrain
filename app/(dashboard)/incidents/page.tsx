"use client";

import { AlertTriangle, ArrowLeftRight, CheckCircle2, ClipboardPlus, Download, ExternalLink, GitPullRequest, Search, ShieldCheck, Wand2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ApprovalGate } from "@/components/approval-gate/ApprovalGate";

type Incident = {
  id: string;
  source: string;
  status: "open" | "investigating" | "resolved" | "rejected";
  title: string;
  logs: string;
  repo?: string;
  environment?: string;
  service?: string;
  severity?: "low" | "medium" | "high" | "critical";
  branch?: string;
  commit?: string;
  releaseVersion?: string;
  rootCause?: string | null;
  fixProposal?: string | null;
  postmortem?: string | null;
  aiAnalysis?: IncidentAnalysis | null;
  externalId?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  resolvedAt?: string | null;
  resolutionNote?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  hotfixBranch?: string | null;
  hotfixBaseBranch?: string | null;
  hotfixPrNumber?: number | null;
  hotfixPrUrl?: string | null;
  hotfixPrStatus?: string | null;
  hotfixMergeSha?: string | null;
  hotfixCommits?: ReleaseCommit[];
  fixApprovedAt?: string | null;
  reverseSyncPrNumber?: number | null;
  reverseSyncPrUrl?: string | null;
  reverseSyncPrStatus?: string | null;
  reverseSyncBranch?: string | null;
  reverseSyncCreatedAt?: string | null;
  reverseSyncMergedAt?: string | null;
  reverseSyncError?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type IncidentAnalysis = {
  rootCause: string;
  fixProposal: string;
  rollbackSteps: string[];
  changeSummary?: string;
  implicatedCommits?: {
    sha: string;
    message: string;
    reason: string;
    risk: string;
  }[];
  confidence: number;
  releaseContext?: ReleaseContext | null;
};

type ReleaseCommit = {
  sha: string;
  shortSha: string;
  message: string;
  author?: string;
  url?: string;
};

type ReleaseContext = {
  featureBranch?: string | null;
  baseBranch?: string | null;
  draftPr?: { number: number; url?: string; status?: string } | null;
  release?: {
    tag?: string | null;
    status?: string | null;
    sha?: string | null;
    mergeSha?: string | null;
    releasePrNumber?: number | null;
    releasePrUrl?: string | null;
    releasePrStatus?: string | null;
  };
  commits?: {
    featurePr?: ReleaseCommit[];
    releasePr?: ReleaseCommit[];
  };
};

function summarizeIncidentLogs(logs: string) {
  const fallback = logs.replace(/\s+/g, " ").trim();

  try {
    const parsed = JSON.parse(logs);
    const details = parsed?.event?.data?.incident ?? parsed?.payload ?? parsed;
    const customDetails =
      details?.body?.details ??
      details?.custom_details ??
      details?.payload?.custom_details ??
      parsed?.payload?.custom_details ??
      {};

    const summary =
      customDetails.error ??
      customDetails.logs ??
      details?.description ??
      details?.summary ??
      parsed?.payload?.summary;

    if (typeof summary === "string" && summary.trim()) {
      return summary.replace(/\s+/g, " ").trim();
    }
  } catch {
    // Plain-text manual incidents are already summary friendly.
  }

  return fallback;
}

function restoreIncidentAnalysis(incident: Incident): IncidentAnalysis | null {
  if (incident.aiAnalysis) return incident.aiAnalysis;
  if (!incident.rootCause && !incident.fixProposal) return null;

  return {
    rootCause: incident.rootCause ?? "Previous AI analysis was saved without a root cause summary.",
    fixProposal: incident.fixProposal ?? "Previous AI analysis was saved without a fix proposal.",
    rollbackSteps: ["Review hotfix PR commits", "Merge approved fix", "Verify CI and alert recovery"],
    changeSummary: "This analysis was restored from the saved incident fix summary.",
    implicatedCommits: [],
    confidence: 0.7,
    releaseContext: null
  };
}

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selected, setSelected] = useState<Incident | null>(null);
  const [analysis, setAnalysis] = useState<IncidentAnalysis | null>(null);
  const [postmortem, setPostmortem] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [manualLogs, setManualLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [hotfixBusy, setHotfixBusy] = useState(false);
  const [hotfixBaseBranch, setHotfixBaseBranch] = useState("develop");
  const [statusBusy, setStatusBusy] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [postmortemModalOpen, setPostmortemModalOpen] = useState(false);
  const [postmortemLoading, setPostmortemLoading] = useState(false);

  useEffect(() => {
    void loadIncidents();
  }, []);

  useEffect(() => {
    if (!analyzing) return;

    setAnalysisProgress(8);
    const timer = window.setInterval(() => {
      setAnalysisProgress((current) => {
        if (current < 35) return current + 7;
        if (current < 70) return current + 4;
        if (current < 88) return current + 2;
        return current;
      });
    }, 650);

    return () => window.clearInterval(timer);
  }, [analyzing]);

  async function loadIncidents() {
    try {
      const response = await fetch("/api/incidents", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to load incidents");
      setIncidents(json);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load incidents");
    } finally {
      setLoading(false);
    }
  }

  async function analyze() {
    if (!selected) return;
    setAnalysis(null);
    setPostmortem("");
    setActionMessage("");
    setError("");
    setAnalyzing(true);

    try {
      const response = await fetch("/api/ai/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "analyze", incident: selected })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to analyze incident");
      setAnalysisProgress(100);
      setAnalysis(json);
      await persistIncident({
        id: selected.id,
        rootCause: json.rootCause,
        fixProposal: json.fixProposal,
        aiAnalysis: json
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to analyze incident");
      setAnalysisProgress(0);
    } finally {
      window.setTimeout(() => setAnalyzing(false), 450);
    }
  }

  async function generatePostmortem() {
    if (!selected) return;
    setPostmortemLoading(true);
    setPostmortemModalOpen(true);
    setPostmortem("");
    try {
      const response = await fetch("/api/ai/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "postmortem", incident: selected, analysis, releaseContext: analysis?.releaseContext })
      });
      const json = await response.json();
      setPostmortem(json.postmortem ?? "");
      if (json.postmortem) {
        await persistIncident({
          id: selected.id,
          rootCause: analysis?.rootCause,
          fixProposal: analysis?.fixProposal,
          postmortem: json.postmortem
        });
        setActionMessage("Post-mortem draft saved to ShipBrain. It will be included when the fix is approved.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate post-mortem");
    } finally {
      setPostmortemLoading(false);
    }
  }

  async function persistIncident(payload: Record<string, unknown>) {
    const response = await fetch("/api/incidents", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.detail ?? json.error ?? "Unable to update incident");
    }
    setSelected(json);
    setIncidents((items) => items.map((item) => (item.id === json.id ? json : item)));
    return json as Incident;
  }

  async function createManualIncident() {
    const response = await fetch("/api/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "simulation", logs: manualLogs })
    });
    const incident = await response.json();
    if (!response.ok) {
      setError(incident.detail ?? incident.error ?? "Unable to create incident");
      return;
    }
    setIncidents((items) => [incident, ...items]);
    setSelected(incident);
    setManualOpen(false);
    setManualLogs("");
  }

  async function acknowledgeIncident() {
    if (!selected) return;
    setStatusBusy(true);
    setError("");
    try {
      const response = await fetch("/api/incidents", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected.id, action: "acknowledge" })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to acknowledge incident");
      setSelected(json);
      setIncidents((items) => items.map((item) => (item.id === json.id ? json : item)));
      setActionMessage("Incident acknowledged. You are now investigating this issue.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to acknowledge incident");
    } finally {
      setStatusBusy(false);
    }
  }

  async function resolveIncident() {
    if (!selected) return;
    setStatusBusy(true);
    setError("");
    try {
      const response = await fetch("/api/incidents", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected.id, action: "resolve", note: resolveNote || "Resolved" })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to resolve incident");
      setSelected(json);
      setIncidents((items) => items.map((item) => (item.id === json.id ? json : item)));
      setResolveModalOpen(false);
      setResolveNote("");
      setActionMessage("Incident resolved successfully.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to resolve incident");
    } finally {
      setStatusBusy(false);
    }
  }

  async function rejectIncident() {
    if (!selected) return;
    setStatusBusy(true);
    setError("");
    try {
      const response = await fetch("/api/incidents", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected.id, action: "reject", note: rejectReason || "Not actionable" })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to reject incident");
      setSelected(json);
      setIncidents((items) => items.map((item) => (item.id === json.id ? json : item)));
      setRejectModalOpen(false);
      setRejectReason("");
      setActionMessage("Incident rejected as not actionable.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to reject incident");
    } finally {
      setStatusBusy(false);
    }
  }

  async function createHotfixDraftPr() {
    if (!selected || !analysis) return;
    setHotfixBusy(true);
    setError("");
    setActionMessage("");
    try {
      const response = await fetch("/api/incidents/hotfix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          incidentId: selected.id,
          analysis,
          releaseContext: analysis.releaseContext,
          baseBranch: hotfixBaseBranch
        })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to create hotfix Draft PR");
      setSelected(json.incident);
      setIncidents((items) => items.map((item) => (item.id === json.incident.id ? json.incident : item)));
      setActionMessage(`Hotfix Draft PR #${json.pr.number} created on ${json.pr.branch}. Developer commits should continue on this branch.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to create hotfix Draft PR");
    } finally {
      setHotfixBusy(false);
    }
  }

  async function approveHotfix(note: string) {
    if (!selected) return;
    setHotfixBusy(true);
    setError("");
    try {
      const response = await fetch("/api/incidents/hotfix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", incidentId: selected.id, note })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to approve and merge incident hotfix");
      setSelected(json.incident);
      setIncidents((items) => items.map((item) => (item.id === json.incident.id ? json.incident : item)));
      setGateOpen(false);
      const reverseSyncMsg = json.reverseSync
        ? ` Reverse sync PR #${json.reverseSync.prNumber} ${json.reverseSync.created ? "created" : "found"} to sync changes to ${json.reverseSync.targetBranch}.`
        : json.reverseSyncError
          ? ` Reverse sync failed: ${json.reverseSyncError}`
          : "";
      setActionMessage(
        json.deployment
          ? `Hotfix PR #${json.incident.hotfixPrNumber} merged, release ${json.releaseTag} tagged, and production deployment was dispatched.${reverseSyncMsg}`
          : `Hotfix PR #${json.incident.hotfixPrNumber} merged, but production deployment dispatch needs attention: ${json.deploymentError ?? "unknown deployment error"}${reverseSyncMsg}`
      );
          } catch (nextError) {
      setGateOpen(false);
      setError(nextError instanceof Error ? nextError.message : "Unable to approve and merge incident hotfix");
    } finally {
      setHotfixBusy(false);
    }
  }

  async function openApprovalGate() {
    if (!selected?.hotfixPrNumber) return;
    setHotfixBusy(true);
    setError("");
    try {
      const response = await fetch("/api/incidents/hotfix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync", incidentId: selected.id })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to refresh hotfix commits");
      setSelected(json.incident);
      setIncidents((items) => items.map((item) => (item.id === json.incident.id ? json.incident : item)));
      setGateOpen(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to refresh hotfix commits");
    } finally {
      setHotfixBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Pillar 3</div>
          <h1>Incident Commander</h1>
          <p>Capture alerts, analyze logs, approve fixes, and produce post-mortems with standard sections.</p>
        </div>
        <button className="button primary" onClick={() => setManualOpen(true)}>
          <ClipboardPlus size={16} />
          Report incident
        </button>
      </div>

      <section className="grid two">
        <div className="panel">
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="eyebrow">ShipBrain Incident Management</div>
            <h3>Automatic incident detection</h3>
            <p>
              ShipBrain automatically creates incidents when GitHub Actions workflows fail. The workflow files include the ShipBrain webhook for incident alerting.
            </p>
            <pre className="code-view" style={{ maxHeight: 180 }}>{`Incident webhook (for custom integrations):
POST /api/webhooks/incidents
Authorization: Bearer <SHIPBRAIN_API_KEY>

Payload:
{
  "source": "custom",
  "repo": "owner/repo",
  "title": "Incident title",
  "severity": "high",
  "service": "checkout",
  "environment": "production",
  "logs": "Error details..."
}

Incident lifecycle:
open -> investigating -> resolved/rejected

GitHub workflow incidents are auto-created on failure
and auto-resolved when the workflow succeeds.`}</pre>
          </div>
          <h2>Incident Feed</h2>
          {error ? (
            <div className="error-panel" role="alert" style={{ marginBottom: 12 }}>
              <strong>Incident simulation needs attention</strong>
              <p>{error}</p>
            </div>
          ) : null}
          {loading ? (
            <div className="loading-state" role="status">
              <span className="loading-spinner" aria-hidden="true" />
              <strong>Loading incidents</strong>
              <p>Checking saved simulated incident records.</p>
            </div>
          ) : incidents.length ? (
            <div className="split-list">
              {incidents.map((incident) => (
              <button
                className={`card incident-card ${incident.status}`}
                key={incident.id}
                style={{ textAlign: "left", cursor: "pointer" }}
                onClick={() => {
                  setSelected(incident);
                  setAnalysis(restoreIncidentAnalysis(incident));
                  setPostmortem(incident.postmortem ?? "");
                  setHotfixBaseBranch(incident.hotfixBaseBranch ?? "develop");
                  setActionMessage("");
                  setError("");
                  setAnalyzing(false);
                  setAnalysisProgress(0);
                }}
              >
                <div className="incident-card-header">
                  <strong className="incident-card-title">{incident.title}</strong>
                  <span className={`status ${
                    incident.status === "resolved" ? "green" :
                    incident.status === "rejected" ? "" :
                    incident.status === "investigating" ? "amber" :
                    "red"
                  }`}>
                    {incident.status}
                  </span>
                </div>
                <div className="incident-card-meta">
                  <span>{incident.service ?? "service"}</span>
                  <span>{incident.environment ?? "sandbox"}</span>
                  <span>{incident.severity ?? "medium"}</span>
                </div>
                <p className="incident-card-summary">{summarizeIncidentLogs(incident.logs)}</p>
                <div className="incident-card-footer">
                  <div className="toolbar">
                    {incident.releaseVersion ? <span className="status green">release {incident.releaseVersion}</span> : null}
                    {incident.source === "github-workflow" ? <span className="status amber">GitHub</span> : null}
                    {incident.acknowledgedAt && incident.status === "investigating" ? (
                      <span className="status amber">Investigating</span>
                    ) : null}
                    {incident.reverseSyncPrStatus === "merged" ? (
                      <span className="status green">Synced</span>
                    ) : incident.reverseSyncPrNumber ? (
                      <span className="status amber">Sync pending</span>
                    ) : null}
                  </div>
                  <span className="muted-link">View details</span>
                </div>
              </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>No incidents yet</strong>
              <p>Create a manual incident from logs, or connect a production alert webhook when you are ready to automate intake.</p>
            </div>
          )}
        </div>

        <aside className="panel">
          {selected ? (
            <>
              <h2>{selected.title}</h2>
              <div className="toolbar" style={{ marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
                <span className="status amber">{selected.source}</span>
                {selected.severity ? <span className={`status ${selected.severity === "critical" || selected.severity === "high" ? "red" : "amber"}`}>{selected.severity}</span> : null}
                {selected.repo ? <span className="status green">{selected.repo}</span> : null}
                {selected.releaseVersion ? <span className="status green">release {selected.releaseVersion}</span> : null}
                {selected.externalId ? <code style={{ fontSize: 11, padding: "2px 6px", background: "var(--surface-elevated)", borderRadius: 4 }}>{selected.externalId}</code> : null}
              </div>

              {/* Incident Status Actions */}
              {selected.status === "open" ? (
                <div className="card" style={{ marginBottom: 14, background: "var(--surface-warning)", border: "1px solid var(--border-warning)" }}>
                  <div className="toolbar" style={{ justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong style={{ color: "var(--text-warning)" }}>Incident Open</strong>
                      <p style={{ marginBottom: 0, fontSize: 13 }}>Acknowledge to start investigating, or reject if not actionable.</p>
                    </div>
                    <div className="toolbar" style={{ gap: 8 }}>
                      <button className="button primary compact" onClick={acknowledgeIncident} disabled={statusBusy}>
                        <Search size={14} />
                        {statusBusy ? "..." : "Acknowledge"}
                      </button>
                      <button className="button secondary compact" onClick={() => setRejectModalOpen(true)} disabled={statusBusy}>
                        <XCircle size={14} />
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ) : selected.status === "investigating" ? (
                <div className="card" style={{ marginBottom: 14, background: "var(--surface-elevated)", border: "1px solid var(--accent)" }}>
                  <div className="toolbar" style={{ justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong style={{ color: "var(--accent)" }}>Investigating</strong>
                      <p style={{ marginBottom: 0, fontSize: 13 }}>
                        Acknowledged by {selected.acknowledgedBy ?? "user"} at {selected.acknowledgedAt ? new Date(selected.acknowledgedAt).toLocaleString() : "unknown"}
                      </p>
                    </div>
                    <div className="toolbar" style={{ gap: 8 }}>
                      <button className="button primary compact" onClick={() => setResolveModalOpen(true)} disabled={statusBusy}>
                        <CheckCircle2 size={14} />
                        Resolve
                      </button>
                      <button className="button secondary compact" onClick={() => setRejectModalOpen(true)} disabled={statusBusy}>
                        <XCircle size={14} />
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ) : selected.status === "resolved" ? (
                <div className="card" style={{ marginBottom: 14, background: "var(--surface-success)", border: "1px solid var(--border-success)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <CheckCircle2 size={18} style={{ color: "var(--text-success)" }} />
                    <div>
                      <strong style={{ color: "var(--text-success)" }}>Resolved</strong>
                      <p style={{ marginBottom: 0, fontSize: 13 }}>
                        {selected.resolutionNote ?? "No resolution note"}
                        {selected.resolvedAt ? ` - ${new Date(selected.resolvedAt).toLocaleString()}` : ""}
                      </p>
                    </div>
                  </div>
                </div>
              ) : selected.status === "rejected" ? (
                <div className="card" style={{ marginBottom: 14, background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <XCircle size={18} style={{ color: "var(--text-muted)" }} />
                    <div>
                      <strong style={{ color: "var(--text-muted)" }}>Rejected</strong>
                      <p style={{ marginBottom: 0, fontSize: 13 }}>
                        {selected.rejectionReason ?? "Not actionable"}
                        {selected.rejectedAt ? ` - ${new Date(selected.rejectedAt).toLocaleString()}` : ""}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
              {actionMessage ? (
                <div className="success-panel" role="status" style={{ marginBottom: 12 }}>
                  <strong>Incident updated</strong>
                  <p>{actionMessage}</p>
                </div>
              ) : null}
                            <pre className="code-view" style={{ maxHeight: 160 }}>{selected.logs}</pre>
              <div className="toolbar" style={{ marginTop: 14 }}>
                <button className="button primary" disabled={analyzing} onClick={analyze}>
                  <Wand2 size={16} />
                  {analyzing ? "Analyzing..." : "Analyze with AI"}
                </button>
                <button className="button secondary" disabled={!analysis || analyzing || !selected.hotfixPrNumber || hotfixBusy} onClick={openApprovalGate}>
                  <ShieldCheck size={16} />
                  {hotfixBusy ? "Refreshing..." : "Approve fix"}
                </button>
                <button className="button secondary" disabled={!analysis || analyzing} onClick={generatePostmortem}>
                  <Download size={16} />
                  Generate post-mortem
                </button>
              </div>
              {analysis || selected.hotfixPrNumber ? (
                <div className="hotfix-panel">
                  <div>
                    <div className="eyebrow">Incident hotfix workflow</div>
                    <strong>
                      {selected.hotfixPrNumber
                        ? `Draft PR #${selected.hotfixPrNumber} tracks the fix`
                        : "Create a Draft PR for the incident fix"}
                    </strong>
                    <p>
                      {selected.hotfixPrNumber
                        ? "Developer commits should land on this hotfix branch. ShipBrain will show those commits before manager approval."
                        : "ShipBrain will open a hotfix branch with the AI analysis and handoff notes, then wait for developer fix commits."}
                    </p>
                  </div>
                  {!selected.hotfixPrNumber ? (
                    <label className="field-label" style={{ marginTop: 0 }}>
                      Destination branch
                      <input
                        className="input"
                        value={hotfixBaseBranch}
                        onChange={(event) => setHotfixBaseBranch(event.target.value)}
                        placeholder="develop"
                        style={{ marginTop: 6 }}
                      />
                    </label>
                  ) : (
                    <div className="commit-context" style={{ margin: 0 }}>
                      <div>
                        <span className="eyebrow">Hotfix branch</span>
                        <strong>{selected.hotfixBranch}</strong>
                      </div>
                      <div>
                        <span className="eyebrow">Destination</span>
                        <strong>{selected.hotfixBaseBranch ?? "develop"}</strong>
                      </div>
                    </div>
                  )}
                  <div className="toolbar">
                    {selected.hotfixPrUrl ? (
                      <a className="button secondary compact" href={selected.hotfixPrUrl} target="_blank" rel="noreferrer">
                        <GitPullRequest size={15} />
                        PR #{selected.hotfixPrNumber}
                        <ExternalLink size={14} />
                      </a>
                    ) : null}
                    <button className="button primary compact" disabled={!analysis || hotfixBusy || Boolean(selected.hotfixPrNumber) || !hotfixBaseBranch.trim()} onClick={createHotfixDraftPr}>
                      <GitPullRequest size={15} />
                      {hotfixBusy ? "Working..." : "Create hotfix Draft PR"}
                    </button>
                  </div>
                </div>
              ) : null}
              {selected.reverseSyncPrNumber ? (
                <div className="reverse-sync-panel" style={{ marginTop: 16, padding: 16, background: "var(--surface-elevated)", borderRadius: 8, border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <ArrowLeftRight size={18} style={{ color: "var(--accent)" }} />
                    <div className="eyebrow" style={{ margin: 0 }}>Branch sync</div>
                    {selected.reverseSyncPrStatus === "merged" ? (
                      <span className="status green" style={{ marginLeft: "auto" }}>
                        <CheckCircle2 size={12} /> Synced
                      </span>
                    ) : (
                      <span className="status amber" style={{ marginLeft: "auto" }}>Pending merge</span>
                    )}
                  </div>
                  <strong>Reverse sync PR #{selected.reverseSyncPrNumber}</strong>
                  <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
                    {selected.reverseSyncPrStatus === "merged"
                      ? `Production hotfix has been synced back to ${selected.reverseSyncBranch ?? "develop"}. Both branches are now in sync.`
                      : `This PR syncs the hotfix from main back to ${selected.reverseSyncBranch ?? "develop"}. Merge it to keep branches aligned.`}
                  </p>
                  <div className="commit-context" style={{ marginTop: 12 }}>
                    <div>
                      <span className="eyebrow">Source</span>
                      <strong>main</strong>
                    </div>
                    <div>
                      <span className="eyebrow">Target</span>
                      <strong>{selected.reverseSyncBranch ?? "develop"}</strong>
                    </div>
                    <div>
                      <span className="eyebrow">Status</span>
                      <strong>{selected.reverseSyncPrStatus === "merged" ? "Merged" : "Open"}</strong>
                    </div>
                  </div>
                  <div className="toolbar" style={{ marginTop: 12 }}>
                    <a
                      className="button secondary compact"
                      href={selected.reverseSyncPrUrl ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <GitPullRequest size={15} />
                      View PR #{selected.reverseSyncPrNumber}
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </div>
              ) : selected.reverseSyncError ? (
                <div className="error-panel" role="alert" style={{ marginTop: 16 }}>
                  <strong>Reverse sync failed</strong>
                  <p>{selected.reverseSyncError}</p>
                  <p style={{ fontSize: 12, marginTop: 8 }}>
                    Manually create a PR from main to develop to sync the hotfix changes.
                  </p>
                </div>
              ) : null}
              {(analyzing || analysisProgress > 0) && !analysis ? (
                <div className={`progress-panel in-plan ${analyzing ? "streaming" : ""}`} style={{ marginTop: 16 }}>
                  <div className="toolbar" style={{ justifyContent: "space-between" }}>
                    <div>
                      <strong>{analyzing ? "Analyzing incident context" : "Analysis queued"}</strong>
                      <p>
                        {analysisProgress < 40
                          ? "Reading alert payload, release metadata, and checkout logs."
                          : analysisProgress < 76
                            ? "Asking Gemini for likely root cause and rollback direction."
                            : "Structuring fix proposal and confidence signal."}
                      </p>
                    </div>
                    <span className="status amber">~20-40 sec</span>
                  </div>
                  <div className="progress-track" aria-label={`Incident analysis progress ${analysisProgress}%`}>
                    <div className="progress-fill" style={{ width: `${analysisProgress}%` }} />
                  </div>
                  <div className="progress-meta">
                    <span>{analysisProgress}% complete</span>
                    <span>Keep this tab open</span>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-state">
              <strong>Select or report an incident</strong>
              <p>Paste real logs to let Gemini produce root cause analysis, rollback steps, and a post-mortem draft.</p>
            </div>
          )}
              {analysis ? (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="status amber">confidence {Math.round(analysis.confidence * 100)}%</span>
              <h3 style={{ marginTop: 10 }}>Root cause</h3>
              <p>{analysis.rootCause}</p>
              {analysis.changeSummary ? (
                <>
                  <h3>How it occurred</h3>
                  <p>{analysis.changeSummary}</p>
                </>
              ) : null}
              {analysis.releaseContext ? (
                <>
                  <h3>Branch and release trail</h3>
                  <div className="commit-context">
                    <div>
                      <span className="eyebrow">Feature branch</span>
                      <strong>{selected?.hotfixBranch ?? analysis.releaseContext.featureBranch ?? "not linked"}</strong>
                    </div>
                    <div>
                      <span className="eyebrow">Target branch</span>
                      <strong>{selected?.hotfixBaseBranch ?? analysis.releaseContext.baseBranch ?? "develop"}</strong>
                    </div>
                    <div>
                      <span className="eyebrow">Release</span>
                      <strong>{analysis.releaseContext.release?.tag ?? selected?.releaseVersion ?? "not tagged"}</strong>
                    </div>
                  </div>
                </>
              ) : null}
              {analysis.implicatedCommits?.length ? (
                <>
                  <h3>Commit evidence</h3>
                  <div className="split-list compact-list">
                    {analysis.implicatedCommits.map((commit) => (
                      <div className="commit-row" key={`${commit.sha}-${commit.message}`}>
                        <code>{commit.sha.slice(0, 7)}</code>
                        <div>
                          <strong>{commit.message}</strong>
                          <p>{commit.reason}</p>
                          <span className="status amber">{commit.risk}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : analysis.releaseContext?.commits?.featurePr?.length ? (
                <>
                  <h3>Related commits</h3>
                  <div className="split-list compact-list">
                    {analysis.releaseContext.commits.featurePr.slice(0, 6).map((commit) => (
                      <div className="commit-row" key={commit.sha}>
                        <code>{commit.shortSha}</code>
                        <div>
                          <strong>{commit.message}</strong>
                          <p>{commit.author ?? "GitHub"} · feature PR history</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : selected?.hotfixCommits?.length ? (
                <>
                  <h3>Hotfix PR commits</h3>
                  <div className="split-list compact-list">
                    {selected.hotfixCommits.slice(0, 8).map((commit) => (
                      <div className="commit-row" key={commit.sha}>
                        <code>{commit.shortSha ?? commit.sha.slice(0, 7)}</code>
                        <div>
                          <strong>{commit.message}</strong>
                          <p>{commit.author ?? "GitHub"} · hotfix branch history</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              <h3>Fix proposal</h3>
              <p>{analysis.fixProposal}</p>
              <h3>Rollback steps</h3>
              <p>{analysis.rollbackSteps.join(" → ")}</p>
            </div>
          ) : null}
          {postmortem && !postmortemModalOpen ? <pre className="code-view" style={{ marginTop: 16, maxHeight: 340 }}>{postmortem}</pre> : null}
        </aside>
      </section>

      {manualOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setManualOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Manual incident</h2>
            <textarea
              className="textarea"
              placeholder="Paste alert payload or logs"
              value={manualLogs}
              onChange={(event) => setManualLogs(event.target.value)}
            />
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="button secondary" onClick={() => setManualOpen(false)}>Cancel</button>
              <button className="button primary" disabled={!manualLogs.trim()} onClick={createManualIncident}>Submit</button>
            </div>
          </div>
        </div>
      ) : null}

      {resolveModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setResolveModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Resolve Incident</h2>
            <p>Add a resolution note to close this incident.</p>
            <textarea
              className="textarea"
              placeholder="Describe how the incident was resolved..."
              value={resolveNote}
              onChange={(event) => setResolveNote(event.target.value)}
              rows={4}
            />
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="button secondary" onClick={() => setResolveModalOpen(false)}>Cancel</button>
              <button className="button primary" onClick={resolveIncident} disabled={statusBusy}>
                <CheckCircle2 size={14} />
                {statusBusy ? "Resolving..." : "Resolve"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rejectModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setRejectModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Reject Incident</h2>
            <p>Explain why this incident is not actionable.</p>
            <textarea
              className="textarea"
              placeholder="Reason for rejection (e.g., false positive, duplicate, not an incident)..."
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              rows={4}
            />
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="button secondary" onClick={() => setRejectModalOpen(false)}>Cancel</button>
              <button className="button primary" onClick={rejectIncident} disabled={statusBusy}>
                <XCircle size={14} />
                {statusBusy ? "Rejecting..." : "Reject"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {postmortemModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPostmortemModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 700, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Post-Mortem Report</h2>
              <button className="button secondary compact" onClick={() => setPostmortemModalOpen(false)}>
                <XCircle size={14} />
              </button>
            </div>

            {/* Commit History Section */}
            {(analysis?.releaseContext?.commits?.featurePr?.length || selected?.hotfixCommits?.length || analysis?.implicatedCommits?.length) ? (
              <div style={{ marginBottom: 16, padding: 12, background: "var(--surface-elevated)", borderRadius: 8, border: "1px solid var(--border)" }}>
                <div className="eyebrow" style={{ marginBottom: 8 }}>Commit History</div>
                <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
                  {analysis?.releaseContext?.featureBranch && (
                    <div>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Source branch</span>
                      <strong style={{ display: "block" }}>{analysis.releaseContext.featureBranch}</strong>
                    </div>
                  )}
                  {analysis?.releaseContext?.baseBranch && (
                    <div>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Target branch</span>
                      <strong style={{ display: "block" }}>{analysis.releaseContext.baseBranch}</strong>
                    </div>
                  )}
                  {(analysis?.releaseContext?.release?.tag || selected?.releaseVersion) && (
                    <div>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Release tag</span>
                      <strong style={{ display: "block" }}>{analysis?.releaseContext?.release?.tag ?? selected?.releaseVersion}</strong>
                    </div>
                  )}
                </div>
                <div className="split-list compact-list" style={{ maxHeight: 150, overflow: "auto" }}>
                  {(selected?.hotfixCommits ?? analysis?.releaseContext?.commits?.featurePr ?? analysis?.implicatedCommits ?? []).slice(0, 10).map((commit: any) => (
                    <div className="commit-row" key={commit.sha} style={{ padding: "6px 0" }}>
                      <code style={{ fontSize: 11 }}>{commit.shortSha ?? commit.sha?.slice(0, 7)}</code>
                      <div>
                        <strong style={{ fontSize: 13 }}>{commit.message}</strong>
                        {commit.author && <p style={{ fontSize: 11, margin: 0 }}>{commit.author}</p>}
                        {commit.reason && <p style={{ fontSize: 11, margin: 0, color: "var(--text-muted)" }}>{commit.reason}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Post-mortem Content */}
            <div style={{ flex: 1, overflow: "auto" }}>
              {postmortemLoading ? (
                <div className="loading-state" role="status" style={{ padding: 32 }}>
                  <span className="loading-spinner" aria-hidden="true" />
                  <strong>Generating post-mortem...</strong>
                  <p>AI is analyzing the incident context, commits, and creating a structured report.</p>
                </div>
              ) : postmortem ? (
                <pre className="code-view" style={{ maxHeight: "none", margin: 0 }}>{postmortem}</pre>
              ) : (
                <div className="empty-state">
                  <strong>No post-mortem generated</strong>
                  <p>There was an issue generating the post-mortem report.</p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
              <button className="button secondary" onClick={() => setPostmortemModalOpen(false)}>Close</button>
              {postmortem && (
                <button className="button primary" onClick={() => navigator.clipboard.writeText(postmortem)}>
                  <Download size={14} />
                  Copy to clipboard
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <ApprovalGate
        open={gateOpen}
        title="Approve incident fix"
        description={selected?.hotfixPrNumber ? "ShipBrain will merge the hotfix PR, trigger GitHub CI on the target branch, resolve the linked production alert, and record the fix approval." : "Create the hotfix Draft PR first so ShipBrain can review the actual fix commits before approval."}
        entityType="incident"
        entityId={selected?.id ?? "none"}
        details={
          selected && analysis ? (
            <div className="approval-context">
              <div className="commit-context">
                <div>
                  <span className="eyebrow">Branch</span>
                  <strong>{selected.hotfixBranch ?? analysis.releaseContext?.featureBranch ?? selected.branch ?? "not linked"}</strong>
                </div>
                <div>
                  <span className="eyebrow">PR target</span>
                  <strong>{selected.hotfixBaseBranch ?? analysis.releaseContext?.baseBranch ?? "develop"}</strong>
                </div>
              </div>
              <strong>{selected.hotfixPrNumber ? `Hotfix PR #${selected.hotfixPrNumber} commits reviewed for this fix` : "Create hotfix PR before approval"}</strong>
              {selected.hotfixCommits?.length ? (
                <div className="split-list compact-list" style={{ marginTop: 10 }}>
                  {selected.hotfixCommits.slice(0, 8).map((commit) => (
                    <div className="commit-row" key={commit.sha}>
                      <code>{commit.shortSha ?? commit.sha.slice(0, 7)}</code>
                      <div>
                        <strong>{commit.message}</strong>
                        <p>{commit.author ?? "GitHub"} · will be merged on approval</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : analysis.implicatedCommits?.length ? (
                <div className="split-list compact-list" style={{ marginTop: 10 }}>
                  {analysis.implicatedCommits.slice(0, 5).map((commit) => (
                    <div className="commit-row" key={`${commit.sha}-${commit.reason}`}>
                      <code>{commit.sha.slice(0, 7)}</code>
                      <div>
                        <strong>{commit.message}</strong>
                        <p>{commit.reason}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : analysis.releaseContext?.commits?.featurePr?.length ? (
                <div className="split-list compact-list" style={{ marginTop: 10 }}>
                  {analysis.releaseContext.commits.featurePr.slice(0, 5).map((commit) => (
                    <div className="commit-row" key={commit.sha}>
                      <code>{commit.shortSha}</code>
                      <div>
                        <strong>{commit.message}</strong>
                        <p>{commit.author ?? "GitHub"} · feature branch history</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No linked commits were found. The approval will resolve the incident using the AI analysis and current release metadata.</p>
              )}
            </div>
          ) : null
        }
        onApprove={async (note) => {
          if (!selected) return;
          if (!selected.hotfixPrNumber) {
            setGateOpen(false);
            setError("Create the incident hotfix Draft PR before approving the fix. ShipBrain needs the PR commits to review and merge.");
            return;
          }
          await approveHotfix(note);
        }}
        onReject={() => setGateOpen(false)}
        onClose={() => setGateOpen(false)}
      />
    </>
  );
}
