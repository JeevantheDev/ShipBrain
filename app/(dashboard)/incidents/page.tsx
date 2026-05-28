"use client";

import { AlertTriangle, ArrowLeftRight, CheckCircle2, ClipboardPlus, Download, ExternalLink, GitBranch, GitPullRequest, Search, ShieldCheck, Wand2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ApprovalGate } from "@/components/approval-gate/ApprovalGate";
import { IncidentTemplateEditor, getDefaultTemplate, templateToLogs, type IncidentTemplateData } from "@/components/incidents/IncidentTemplateEditor";

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
  // New template editor state
  const [templateData, setTemplateData] = useState<IncidentTemplateData>(getDefaultTemplate());
  const [createHotfixOnSubmit, setCreateHotfixOnSubmit] = useState(true);
  const [hotfixTargetBranch, setHotfixTargetBranch] = useState("main");
  const [runAiAnalysis, setRunAiAnalysis] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
    if (!templateData.title.trim() || !templateData.description.trim()) {
      setError("Title and description are required");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      // Create the incident
      const logs = templateToLogs(templateData);
      const response = await fetch("/api/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "manual",
          title: templateData.title,
          severity: templateData.severity,
          service: templateData.service || undefined,
          environment: templateData.environment,
          logs
        })
      });
      const incident = await response.json();
      if (!response.ok) {
        throw new Error(incident.detail ?? incident.error ?? "Unable to create incident");
      }

      setIncidents((items) => [incident, ...items]);
      setSelected(incident);
      setAnalysis(null);

      // Optionally run AI analysis
      if (runAiAnalysis) {
        setAnalyzing(true);
        setAnalysisProgress(8);
        try {
          const analysisRes = await fetch("/api/ai/incident", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "analyze", incident })
          });
          const analysisJson = await analysisRes.json();
          if (analysisRes.ok) {
            setAnalysisProgress(100);
            setAnalysis(analysisJson);
            await persistIncident({
              id: incident.id,
              rootCause: analysisJson.rootCause,
              fixProposal: analysisJson.fixProposal,
              aiAnalysis: analysisJson
            });
          }
        } catch {
          // AI analysis is optional, continue without it
        } finally {
          setAnalyzing(false);
        }
      }

      // Optionally create hotfix branch
      if (createHotfixOnSubmit && incident.id) {
        setHotfixBusy(true);
        try {
          const hotfixRes = await fetch("/api/incidents/hotfix", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "create",
              incidentId: incident.id,
              analysis: analysis ?? {
                rootCause: templateData.description,
                fixProposal: "Fix to be determined by developer",
                rollbackSteps: ["Revert changes", "Verify system stable"],
                confidence: 0.5
              },
              baseBranch: hotfixTargetBranch
            })
          });
          const hotfixJson = await hotfixRes.json();
          if (hotfixRes.ok) {
            setSelected(hotfixJson.incident);
            setIncidents((items) => items.map((item) => (item.id === hotfixJson.incident.id ? hotfixJson.incident : item)));
            setActionMessage(`Incident created with hotfix branch. Draft PR #${hotfixJson.pr.number} ready for fixes.`);
          }
        } catch {
          // Hotfix creation failed, but incident was created
          setActionMessage("Incident created. Hotfix branch creation failed - you can create it manually.");
        } finally {
          setHotfixBusy(false);
        }
      } else {
        setActionMessage("Incident created successfully.");
      }

      // Reset form
      setManualOpen(false);
      setTemplateData(getDefaultTemplate());
      setCreateHotfixOnSubmit(true);
      setRunAiAnalysis(false);
      setHotfixTargetBranch("main");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create incident");
    } finally {
      setSubmitting(false);
    }
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
    if (!selected) return;
    setHotfixBusy(true);
    setError("");
    setActionMessage("");

    // Use analysis if available, otherwise create a basic structure
    const analysisPayload = analysis ?? {
      rootCause: selected.logs ? summarizeIncidentLogs(selected.logs) : "To be determined",
      fixProposal: "Developer to investigate and implement fix",
      rollbackSteps: ["Revert the hotfix PR if issues arise", "Verify system stability"],
      confidence: 0.5,
      releaseContext: null
    };

    try {
      const response = await fetch("/api/incidents/hotfix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          incidentId: selected.id,
          analysis: analysisPayload,
          releaseContext: analysis?.releaseContext ?? null,
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
      const isProd = json.incident.hotfixBaseBranch === "main";
      if (isProd) {
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
      } else {
        setActionMessage(
          json.deployment
            ? `Hotfix PR #${json.incident.hotfixPrNumber} merged and preview deployment was dispatched.`
            : `Hotfix PR #${json.incident.hotfixPrNumber} merged, but preview deployment dispatch failed: ${json.deploymentError ?? "unknown deployment error"}`
        );
      }
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
      <header className="page-head">
        <div>
          <div className="eyebrow mono">
            <span className="bar"></span>
            <span className="pillar-tag">Pillar 04</span>
            Incident Commander
          </div>
          <h1>Capture alerts, analyze logs, and dispatch automated hotfixes.</h1>
          <div className="sub">
            Plain-English diagnostic trace summaries, automated post-mortem document drafting, and main-to-develop reverse sync gating.
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn-primary" onClick={() => setManualOpen(true)}>
            <ClipboardPlus size={14} style={{ marginRight: 4 }} />
            Report Incident
          </button>
        </div>
      </header>

      <section className="grid two">
        <div className="panel">
          <div className="card" style={{ marginBottom: 16, padding: 14 }}>
            <span className="eyebrow mono" style={{ display: "block", marginBottom: 6, fontSize: 10 }}>Automated Intake webhook</span>
            <strong style={{ fontSize: 13.5, display: "block" }}>Automatic alert ingestion integration</strong>
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "4px 0 10px" }}>
              ShipBrain automatically creates incidents when GitHub Actions workflows fail. You can also integrate custom alerting triggers.
            </p>
            <pre className="code-view mono" style={{ fontSize: 11, padding: 10, background: "var(--panel-2)", border: "1px solid var(--line)" }}>{`POST /api/webhooks/incidents
Authorization: Bearer <SHIPBRAIN_API_KEY>

{
  "source": "custom",
  "repo": "owner/repo",
  "title": "Incident title",
  "severity": "high",
  "logs": "Error details..."
}`}</pre>
          </div>

          <header className="panel-head">
            <h2>
              Incident Feed
              <span className="badge-count">{incidents.length} logs</span>
            </h2>
          </header>

          <div style={{ padding: 12 }}>
            {error ? (
              <div className="error-panel" role="alert" style={{ marginBottom: 12 }}>
                <strong>Intake error details</strong>
                <p>{error}</p>
              </div>
            ) : null}

            {loading ? (
              <div style={{ padding: 36, textAlign: "center", color: "var(--text-muted)" }}>
                <span className="loading-spinner" style={{ marginInline: "auto", marginBottom: 8 }} />
                <strong>Loading incidents</strong>
                <p style={{ fontSize: 12 }}>Checking database records...</p>
              </div>
            ) : incidents.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {incidents.map((incident) => {
                  const isSel = selected?.id === incident.id;
                  const isResol = incident.status === "resolved";
                  const isRejec = incident.status === "rejected";
                  const isInvest = incident.status === "investigating";
                  const isCrit = incident.severity === "critical" || incident.severity === "high";

                  return (
                    <button
                      className={`card pr-row ${isSel ? "selected" : ""}`}
                      key={incident.id}
                      style={{
                        textAlign: "left",
                        cursor: "pointer",
                        width: "100%",
                        borderColor: isSel ? "var(--brand)" : undefined,
                        background: isSel ? "var(--panel-2)" : undefined
                      }}
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
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong style={{ fontSize: 13.5, color: "#fff" }}>{incident.title}</strong>
                        <span className={`status-pill ${isResol ? "passed" : isRejec ? "" : isInvest ? "" : "danger"}`}>
                          <span className="dot"></span>
                          {incident.status}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 8, margin: "4px 0 6px", fontSize: 11, color: "var(--text-muted)" }}>
                        <span>service: {incident.service ?? "unknown"}</span>
                        <span>·</span>
                        <span>env: {incident.environment ?? "production"}</span>
                        <span>·</span>
                        <span style={{ color: isCrit ? "var(--red)" : undefined }}>severity: {incident.severity ?? "medium"}</span>
                      </div>
                      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {summarizeIncidentLogs(incident.logs)}
                      </p>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          {incident.releaseVersion && <span className="status-pill passed" style={{ fontSize: 10 }}>release {incident.releaseVersion}</span>}
                          {incident.source === "github-workflow" && <span className="status-pill" style={{ fontSize: 10 }}>GitHub</span>}
                          {incident.reverseSyncPrStatus === "merged" ? (
                            <span className="status-pill passed" style={{ fontSize: 10 }}>Synced</span>
                          ) : incident.reverseSyncPrNumber ? (
                            <span className="status-pill" style={{ fontSize: 10 }}>Sync pending</span>
                          ) : null}
                        </div>
                        <span className="text-link" style={{ fontSize: 11 }}>View details</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: "36px", textAlign: "center", color: "var(--text-muted)" }}>
                <strong>No incidents reported yet</strong>
                <p style={{ fontSize: 12, marginTop: 4 }}>Simulate or report an incident above to get started.</p>
              </div>
            )}
          </div>
        </div>

        <aside className="panel">
          <header className="panel-head">
            <h2>Incident Workspace</h2>
          </header>
          <div style={{ padding: 16 }}>
            {selected ? (
              <>
                <h2 style={{ fontSize: 15, fontWeight: 600 }}>{selected.title}</h2>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0 12px" }}>
                  <span className="status-pill"><span className="dot"></span>{selected.source}</span>
                  {selected.severity && (
                    <span className={`status-pill ${selected.severity === "critical" || selected.severity === "high" ? "danger" : ""}`}>
                      <span className="dot"></span>
                      {selected.severity}
                    </span>
                  )}
                  {selected.repo && <span className="status-pill passed"><span className="dot"></span>{selected.repo}</span>}
                  {selected.releaseVersion && <span className="status-pill passed"><span className="dot"></span>release {selected.releaseVersion}</span>}
                  {selected.externalId && <span className="status-pill mono">{selected.externalId}</span>}
                </div>

                {/* Incident Status Card Alerts */}
                {selected.status === "open" ? (
                  <div className="card" style={{ marginBottom: 14, padding: 12, borderColor: "var(--yellow)", background: "rgba(210, 153, 34, 0.04)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <strong style={{ color: "var(--yellow)", fontSize: 13.5 }}>Incident Open</strong>
                        <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Acknowledge to start investigating, or reject.</p>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn-primary" onClick={acknowledgeIncident} disabled={statusBusy} style={{ height: 28 }}>
                          <Search size={12} />
                          Acknowledge
                        </button>
                        <button className="btn subtle" onClick={() => setRejectModalOpen(true)} disabled={statusBusy} style={{ height: 28 }}>
                          <XCircle size={12} />
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ) : selected.status === "investigating" ? (
                  <div className="card" style={{ marginBottom: 14, padding: 12, borderColor: "var(--brand)", background: "rgba(163, 113, 247, 0.04)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <strong style={{ color: "var(--brand)", fontSize: 13.5 }}>Investigating Incident</strong>
                        <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                          Assigned to {selected.acknowledgedBy ?? "operator"} at {selected.acknowledgedAt ? new Date(selected.acknowledgedAt).toLocaleTimeString() : "unknown"}
                        </p>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn-primary" onClick={() => setResolveModalOpen(true)} disabled={statusBusy} style={{ height: 28 }}>
                          <CheckCircle2 size={12} />
                          Resolve
                        </button>
                        <button className="btn subtle" onClick={() => setRejectModalOpen(true)} disabled={statusBusy} style={{ height: 28 }}>
                          <XCircle size={12} />
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ) : selected.status === "resolved" ? (
                  <div className="card" style={{ marginBottom: 14, padding: 12, borderColor: "var(--green)", background: "rgba(63, 185, 80, 0.04)" }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <CheckCircle2 size={16} style={{ color: "var(--green)", marginTop: 2 }} />
                      <div>
                        <strong style={{ color: "var(--green)", fontSize: 13.5 }}>Resolved successfully</strong>
                        <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                          {selected.resolutionNote ?? "Closed"} · {selected.resolvedAt ? new Date(selected.resolvedAt).toLocaleString() : ""}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : selected.status === "rejected" ? (
                  <div className="card" style={{ marginBottom: 14, padding: 12 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <XCircle size={16} style={{ color: "var(--text-muted)", marginTop: 2 }} />
                      <div>
                        <strong style={{ fontSize: 13.5 }}>Incident Rejected</strong>
                        <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                          Reason: {selected.rejectionReason ?? "not actionable"} · {selected.rejectedAt ? new Date(selected.rejectedAt).toLocaleTimeString() : ""}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}

                {actionMessage ? (
                  <div className="success-panel" role="status" style={{ marginBottom: 12 }}>
                    <strong>Incident status updated</strong>
                    <p>{actionMessage}</p>
                  </div>
                ) : null}

                <div className="code-view-container" style={{ marginBottom: 12 }}>
                  <pre className="code-view mono" style={{ maxHeight: 150, fontSize: 11, padding: 10, background: "var(--panel-2)", border: "1px solid var(--line)" }}>{selected.logs}</pre>
                </div>

                {/* Action Buttons - Context-aware based on status */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                  {/* Primary Actions Row */}
                  <div style={{ display: "flex", gap: 6 }}>
                    {/* AI Analysis - Optional */}
                    <button
                      className="btn subtle"
                      disabled={analyzing || selected.status === "resolved"}
                      onClick={analyze}
                      style={{ flex: 1, justifyContent: "center" }}
                      title="AI analysis is optional - you can proceed without it"
                    >
                      <Wand2 size={12} />
                      {analyzing ? "Analyzing..." : analysis ? "Re-analyze" : "Analyze with AI"}
                      <span style={{ fontSize: 9, marginLeft: 4, opacity: 0.7 }}>(optional)</span>
                    </button>

                    {/* Create Draft PR - Available after acknowledging */}
                    {selected.status === "investigating" && !selected.hotfixPrNumber && (
                      <button
                        className="btn-primary"
                        disabled={hotfixBusy || !hotfixBaseBranch.trim()}
                        onClick={createHotfixDraftPr}
                        style={{ flex: 1, justifyContent: "center" }}
                      >
                        <GitPullRequest size={12} />
                        {hotfixBusy ? "Creating..." : "Create Draft PR"}
                      </button>
                    )}

                    {/* Approve Fix - Available when PR exists and incident is not resolved/rejected */}
                    {selected.status !== "resolved" && selected.status !== "rejected" && selected.hotfixPrNumber && (
                      <button
                        className="btn-primary"
                        disabled={hotfixBusy}
                        onClick={openApprovalGate}
                        style={{ flex: 1, justifyContent: "center" }}
                      >
                        <ShieldCheck size={12} />
                        {hotfixBusy ? "Syncing..." : "Approve Fix"}
                      </button>
                    )}
                  </div>

                  {/* Secondary Actions Row */}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn subtle"
                      disabled={!analysis || analyzing}
                      onClick={generatePostmortem}
                      style={{ flex: 1, justifyContent: "center" }}
                    >
                      <Download size={12} />
                      Draft post-mortem
                    </button>
                    {selected.hotfixPrUrl && (
                      <a
                        className="btn subtle"
                        href={selected.hotfixPrUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ flex: 1, justifyContent: "center" }}
                      >
                        <ExternalLink size={12} />
                        View PR #{selected.hotfixPrNumber}
                      </a>
                    )}
                  </div>
                </div>

                {/* Hotfix Panel - Show when investigating or has PR, but not for rejected incidents */}
                {(selected.status === "investigating" || selected.hotfixPrNumber) && selected.status !== "rejected" && (
                  <div className="card" style={{ padding: 12, background: "var(--panel-2)", border: "1px dashed var(--line)", marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <GitBranch size={14} style={{ color: "var(--brand)" }} />
                      <span className="eyebrow mono" style={{ fontSize: 10 }}>Hotfix Pipeline</span>
                      {selected.hotfixPrNumber && (
                        <span className="status-pill passed" style={{ marginLeft: "auto", fontSize: 10 }}>
                          PR #{selected.hotfixPrNumber}
                        </span>
                      )}
                    </div>

                    <strong style={{ fontSize: 13.5 }}>
                      {selected.hotfixPrNumber
                        ? selected.hotfixPrStatus === "merged"
                          ? "Hotfix merged successfully"
                          : "Draft PR ready for fixes"
                        : "Configure hotfix branch"}
                    </strong>
                    <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "4px 0 10px" }}>
                      {selected.hotfixPrNumber
                        ? selected.hotfixPrStatus === "merged"
                          ? "The hotfix has been merged and deployed."
                          : "Push fix commits to the branch. Click 'Approve Fix' when ready to merge and deploy."
                        : "Select target branch and create a draft PR with incident context for developers."}
                    </p>

                    {!selected.hotfixPrNumber ? (
                      <div style={{ marginBottom: 10 }}>
                        <label className="field-label" htmlFor="hotfix-base" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                          Target branch for hotfix
                        </label>
                        <select
                          id="hotfix-base"
                          className="input"
                          value={hotfixBaseBranch}
                          onChange={(event) => setHotfixBaseBranch(event.target.value)}
                          style={{
                            width: "100%",
                            height: 36,
                            padding: "0 12px",
                            fontSize: 13,
                            color: "var(--text)",
                            background: "var(--panel-2)",
                            border: "1px solid var(--line)",
                            borderRadius: 4,
                            cursor: "pointer",
                            appearance: "auto"
                          }}
                        >
                          <option value="main">main (Production hotfix)</option>
                          <option value="develop">develop (Preview fix)</option>
                        </select>
                        <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-muted)" }}>
                          {hotfixBaseBranch === "main"
                            ? "Hotfix will deploy to production. Changes auto-sync to develop after merge."
                            : "Fix will deploy to preview environment only."}
                        </p>
                      </div>
                    ) : (
                      <div className="commit-context" style={{ padding: 8, background: "var(--bg)", border: "1px solid var(--line)", marginBottom: 10 }}>
                        <div>
                          <span className="eyebrow mono" style={{ fontSize: 9 }}>Hotfix branch</span>
                          <strong>{selected.hotfixBranch}</strong>
                        </div>
                        <div>
                          <span className="eyebrow mono" style={{ fontSize: 9 }}>Target branch</span>
                          <strong>{selected.hotfixBaseBranch ?? "develop"}</strong>
                        </div>
                        {selected.hotfixBaseBranch === "main" && !selected.reverseSyncPrNumber && selected.hotfixPrStatus !== "merged" && (
                          <div>
                            <span className="eyebrow mono" style={{ fontSize: 9 }}>Auto-sync</span>
                            <strong style={{ color: "var(--brand)" }}>main → develop</strong>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Commit list if PR exists */}
                    {selected.hotfixCommits && selected.hotfixCommits.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <span className="eyebrow mono" style={{ fontSize: 9, display: "block", marginBottom: 6 }}>Commits ({selected.hotfixCommits.length})</span>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 100, overflow: "auto" }}>
                          {selected.hotfixCommits.slice(0, 5).map((commit) => (
                            <div key={commit.sha} style={{ display: "flex", gap: 8, fontSize: 11 }}>
                              <code className="mono" style={{ color: "var(--brand)" }}>{commit.shortSha ?? commit.sha.slice(0, 7)}</code>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{commit.message}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 6 }}>
                      {selected.hotfixPrUrl && (
                        <a className="btn subtle compact" href={selected.hotfixPrUrl} target="_blank" rel="noreferrer" style={{ flex: 1, justifyContent: "center" }}>
                          <ExternalLink size={12} />
                          View PR
                        </a>
                      )}
                      {!selected.hotfixPrNumber && (
                        <button
                          className="btn-primary compact"
                          disabled={hotfixBusy || !hotfixBaseBranch.trim()}
                          onClick={createHotfixDraftPr}
                          style={{ flex: 1, justifyContent: "center" }}
                        >
                          <GitPullRequest size={12} />
                          {hotfixBusy ? "Creating..." : "Create Draft PR"}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Reverse Sync Panel */}
                {selected.reverseSyncPrNumber ? (
                  <div className="card" style={{ padding: 12, background: "var(--panel-2)", border: "1px solid var(--line)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <ArrowLeftRight size={14} style={{ color: "var(--brand)" }} />
                      <span className="eyebrow mono" style={{ fontSize: 10 }}>Reverse Sync Gating</span>
                      {selected.reverseSyncPrStatus === "merged" ? (
                        <span className="status-pill passed" style={{ marginLeft: "auto", fontSize: 10 }}>Merged</span>
                      ) : (
                        <span className="status-pill" style={{ marginLeft: "auto", fontSize: 10 }}>Pending merge</span>
                      )}
                    </div>
                    <strong style={{ fontSize: 13.5 }}>Reverse sync PR #{selected.reverseSyncPrNumber}</strong>
                    <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "4px 0 10px" }}>
                      {selected.reverseSyncPrStatus === "merged"
                        ? `The hotfix has been successfully back-synced into ${selected.reverseSyncBranch ?? "develop"}.`
                        : `Keep integration branch aligned: sync changes from main back into ${selected.reverseSyncBranch ?? "develop"}.`}
                    </p>
                    <div className="commit-context" style={{ padding: 8, background: "var(--bg)", border: "1px solid var(--line)", marginBottom: 10 }}>
                      <div>
                        <span className="eyebrow mono" style={{ fontSize: 9 }}>Source branch</span>
                        <strong>main</strong>
                      </div>
                      <div>
                        <span className="eyebrow mono" style={{ fontSize: 9 }}>Destination target</span>
                        <strong>{selected.reverseSyncBranch ?? "develop"}</strong>
                      </div>
                    </div>
                    <a
                      className="btn subtle compact"
                      href={selected.reverseSyncPrUrl ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      style={{ width: "100%", justifyContent: "center" }}
                    >
                      <GitPullRequest size={12} style={{ marginRight: 4 }} />
                      View Sync PR #{selected.reverseSyncPrNumber}
                    </a>
                  </div>
                ) : selected.reverseSyncError ? (
                  <div className="error-panel" role="alert" style={{ marginTop: 14 }}>
                    <strong>Reverse sync failed</strong>
                    <p>{selected.reverseSyncError}</p>
                    <p style={{ fontSize: 12, marginTop: 8 }}>
                      Manually create a PR from main to develop to sync the hotfix changes.
                    </p>
                  </div>
                ) : null}

                {/* Progress Loader */}
                {(analyzing || analysisProgress > 0) && !analysis && (
                  <div className="progress-strip" style={{ marginTop: 14, background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 6 }}>
                    <div className="progress-meta">
                      <span className="progress-pct">{analysisProgress}%</span>
                      <span className="progress-status">{analyzing ? "Analyzing incident logs" : "Queued"}</span>
                    </div>
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{
                          width: `${analysisProgress}%`,
                          height: "100%",
                          background: "var(--brand)",
                          transition: "width 0.4s ease"
                        }}
                      />
                    </div>
                    <div className="progress-label">
                      {analysisProgress < 40
                        ? "Ingesting Alert Payload metadata logs."
                        : analysisProgress < 76
                          ? "Querying Gemini trace analyzer."
                          : "Formatting fix proposals."}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ padding: "36px", textAlign: "center", color: "var(--text-muted)" }}>
                <strong>Select or report an incident</strong>
                <p style={{ fontSize: 12, marginTop: 4 }}>Select a log trigger on the left to activate the incident command workspace.</p>
              </div>
            )}

            {analysis && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, borderTop: "1px solid var(--line-muted)", paddingTop: 16 }}>
                <div className="card" style={{ padding: 12 }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    <span className="status-pill danger">confidence {Math.round(analysis.confidence * 100)}%</span>
                  </div>
                  <strong style={{ fontSize: 13, display: "block" }}>Root cause</strong>
                  <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "4px 0 10px" }}>{analysis.rootCause}</p>

                  {analysis.changeSummary && (
                    <>
                      <strong style={{ fontSize: 13, display: "block" }}>Change summary</strong>
                      <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "4px 0 10px" }}>{analysis.changeSummary}</p>
                    </>
                  )}

                  {analysis.releaseContext && (
                    <>
                      <strong style={{ fontSize: 13, display: "block" }}>Release Context</strong>
                      <div className="commit-context" style={{ padding: 8, background: "var(--bg)", border: "1px solid var(--line)" }}>
                        <div>
                          <span className="eyebrow mono" style={{ fontSize: 9 }}>Feature branch</span>
                          <strong>{selected?.hotfixBranch ?? analysis.releaseContext.featureBranch ?? "not linked"}</strong>
                        </div>
                        <div>
                          <span className="eyebrow mono" style={{ fontSize: 9 }}>Integration target</span>
                          <strong>{selected?.hotfixBaseBranch ?? analysis.releaseContext.baseBranch ?? "develop"}</strong>
                        </div>
                        <div>
                          <span className="eyebrow mono" style={{ fontSize: 9 }}>Release tag</span>
                          <strong>{analysis.releaseContext.release?.tag ?? selected?.releaseVersion ?? "not tagged"}</strong>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Commit Rows list */}
                {(analysis.implicatedCommits?.length || analysis.releaseContext?.commits?.featurePr?.length || selected?.hotfixCommits?.length) ? (
                  <div className="card" style={{ padding: 12 }}>
                    <strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>Related Commits</strong>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {(selected?.hotfixCommits ?? analysis.releaseContext?.commits?.featurePr ?? analysis.implicatedCommits ?? []).slice(0, 5).map((commit: any) => (
                        <div className="pr-row" key={commit.sha} style={{ padding: 8, background: "var(--bg)", border: "1px solid var(--line)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <code className="mono" style={{ fontSize: 11, color: "var(--brand)" }}>{commit.shortSha ?? commit.sha?.slice(0, 7)}</code>
                            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{commit.author ?? "git author"}</span>
                          </div>
                          <strong style={{ fontSize: 12.5, display: "block", marginTop: 4 }}>{commit.message}</strong>
                          {commit.reason && <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--text-muted)" }}>{commit.reason}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="card" style={{ padding: 12 }}>
                  <strong style={{ fontSize: 13, display: "block" }}>Fix proposal</strong>
                  <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "4px 0 10px" }}>{analysis.fixProposal}</p>

                  <strong style={{ fontSize: 13, display: "block" }}>Rollback steps</strong>
                  <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "4px 0 0" }}>{analysis.rollbackSteps.join(" → ")}</p>
                </div>
              </div>
            )}

            {postmortem && !postmortemModalOpen && (
              <div style={{ marginTop: 14 }}>
                <strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>Postmortem document draft</strong>
                <pre className="code-view mono" style={{ maxHeight: 220, padding: 10, background: "var(--panel-2)", border: "1px solid var(--line)", fontSize: 11 }}>{postmortem}</pre>
              </div>
            )}
          </div>
        </aside>
      </section>

      {manualOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setManualOpen(false)}>
          <div className="modal" style={{ maxWidth: 720, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <h2 style={{ margin: 0 }}>Report Incident</h2>
                <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "4px 0 0" }}>Use the template below to report a new incident</p>
              </div>
              <button className="btn subtle compact" onClick={() => setManualOpen(false)}>
                <XCircle size={14} />
              </button>
            </div>

            <div style={{ flex: 1, overflow: "auto", paddingRight: 8 }}>
              <IncidentTemplateEditor value={templateData} onChange={setTemplateData} />

              {/* Options Section */}
              <div className="card" style={{ marginTop: 16, padding: 14, background: "var(--panel-2)", border: "1px solid var(--line)" }}>
                <span className="eyebrow mono" style={{ fontSize: 10, display: "block", marginBottom: 10 }}>Incident Response Options</span>

                {/* Create Hotfix Branch Option */}
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={createHotfixOnSubmit}
                    onChange={(e) => setCreateHotfixOnSubmit(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <GitBranch size={14} style={{ color: "var(--brand)" }} />
                      <strong style={{ fontSize: 13 }}>Create hotfix branch automatically</strong>
                    </div>
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                      Creates an isolated hotfix branch with a draft PR ready for fixes
                    </p>
                  </div>
                </label>

                {createHotfixOnSubmit && (
                  <div style={{ marginLeft: 24, marginBottom: 12 }}>
                    <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                      Target branch for hotfix
                    </label>
                    <select
                      className="input"
                      value={hotfixTargetBranch}
                      onChange={(e) => setHotfixTargetBranch(e.target.value)}
                      style={{
                        width: "100%",
                        maxWidth: 200,
                        height: 36,
                        padding: "0 12px",
                        fontSize: 13,
                        color: "var(--text)",
                        background: "var(--panel-2)",
                        border: "1px solid var(--line)",
                        borderRadius: 4,
                        cursor: "pointer",
                        appearance: "auto"
                      }}
                    >
                      <option value="main">main (Production)</option>
                      <option value="develop">develop (Preview)</option>
                    </select>
                    <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-muted)" }}>
                      {hotfixTargetBranch === "main"
                        ? "Hotfix will be merged to main and auto-synced back to develop"
                        : "Hotfix will be merged to develop only"}
                    </p>
                  </div>
                )}

                {/* AI Analysis Option */}
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={runAiAnalysis}
                    onChange={(e) => setRunAiAnalysis(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Wand2 size={14} style={{ color: "var(--brand)" }} />
                      <strong style={{ fontSize: 13 }}>Run AI analysis (optional)</strong>
                    </div>
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                      Analyze incident logs to suggest root cause and fix proposal
                    </p>
                  </div>
                </label>
              </div>
            </div>

            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line-muted)", gap: 8 }}>
              <button className="btn subtle" onClick={() => { setManualOpen(false); setTemplateData(getDefaultTemplate()); }}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!templateData.title.trim() || !templateData.description.trim() || submitting}
                onClick={createManualIncident}
              >
                {submitting ? (
                  <>
                    <span className="loading-spinner" style={{ width: 12, height: 12, marginRight: 6 }} />
                    Creating...
                  </>
                ) : (
                  <>
                    <AlertTriangle size={12} />
                    Report Incident
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {resolveModalOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setResolveModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Resolve Incident</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>Add a resolution note to close this incident.</p>
            <textarea
              className="textarea"
              placeholder="Describe how the incident was resolved..."
              value={resolveNote}
              onChange={(event) => setResolveNote(event.target.value)}
              rows={4}
              style={{ width: "100%", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--line)", padding: 8, borderRadius: 4 }}
            />
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 14, gap: 8 }}>
              <button className="btn subtle" onClick={() => setResolveModalOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={resolveIncident} disabled={statusBusy}>
                <CheckCircle2 size={12} />
                {statusBusy ? "Resolving..." : "Resolve"}
              </button>
            </div>
          </div>
        </div>
      )}

      {rejectModalOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setRejectModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Reject Incident</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>Explain why this incident is not actionable.</p>
            <textarea
              className="textarea"
              placeholder="Reason for rejection (e.g., false positive, duplicate)..."
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              rows={4}
              style={{ width: "100%", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--line)", padding: 8, borderRadius: 4 }}
            />
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 14, gap: 8 }}>
              <button className="btn subtle" onClick={() => setRejectModalOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={rejectIncident} disabled={statusBusy}>
                <XCircle size={12} />
                {statusBusy ? "Rejecting..." : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {postmortemModalOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPostmortemModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 700, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Incident Post-Mortem</h2>
              <button className="btn subtle compact" onClick={() => setPostmortemModalOpen(false)}>
                <XCircle size={14} />
              </button>
            </div>

            {/* Commit History Section */}
            {(analysis?.releaseContext?.commits?.featurePr?.length || selected?.hotfixCommits?.length || analysis?.implicatedCommits?.length) ? (
              <div style={{ marginBottom: 16, padding: 12, background: "var(--panel-2)", borderRadius: 6, border: "1px solid var(--line)" }}>
                <span className="eyebrow mono" style={{ fontSize: 9, display: "block", marginBottom: 6 }}>Related Commit History</span>
                <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
                  {analysis?.releaseContext?.featureBranch && (
                    <div>
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Source branch</span>
                      <strong style={{ display: "block", fontSize: 12.5 }}>{analysis.releaseContext.featureBranch}</strong>
                    </div>
                  )}
                  {analysis?.releaseContext?.baseBranch && (
                    <div>
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Target branch</span>
                      <strong style={{ display: "block", fontSize: 12.5 }}>{analysis.releaseContext.baseBranch}</strong>
                    </div>
                  )}
                  {(analysis?.releaseContext?.release?.tag || selected?.releaseVersion) && (
                    <div>
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Release tag</span>
                      <strong style={{ display: "block", fontSize: 12.5 }}>{analysis?.releaseContext?.release?.tag ?? selected?.releaseVersion}</strong>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 140, overflow: "auto" }}>
                  {(selected?.hotfixCommits ?? analysis?.releaseContext?.commits?.featurePr ?? analysis?.implicatedCommits ?? []).slice(0, 6).map((commit: any) => (
                    <div key={commit.sha} style={{ display: "flex", gap: 10, fontSize: 12, padding: "4px 0" }}>
                      <code className="mono" style={{ fontSize: 11, color: "var(--brand)" }}>{commit.shortSha ?? commit.sha?.slice(0, 7)}</code>
                      <div>
                        <strong>{commit.message}</strong>
                        {commit.author && <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>{commit.author}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Post-mortem Content */}
            <div style={{ flex: 1, overflow: "auto" }}>
              {postmortemLoading ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
                  <span className="loading-spinner" style={{ marginInline: "auto", marginBottom: 8 }} />
                  <strong>Generating post-mortem report</strong>
                  <p style={{ fontSize: 12 }}>AI is building a structured markdown doc...</p>
                </div>
              ) : postmortem ? (
                <pre className="code-view mono" style={{ maxHeight: "none", margin: 0, fontSize: 11.5 }}>{postmortem}</pre>
              ) : (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
                  <strong>No post-mortem generated</strong>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line-muted)", gap: 8 }}>
              <button className="btn subtle" onClick={() => setPostmortemModalOpen(false)}>Close</button>
              {postmortem && (
                <button className="btn-primary" onClick={() => navigator.clipboard.writeText(postmortem)}>
                  <Download size={12} />
                  Copy Markdown
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <ApprovalGate
        open={gateOpen}
        title="Approve incident fix"
        description={selected?.hotfixPrNumber ? "ShipBrain will merge the hotfix PR, trigger GitHub CI on the target branch, resolve the linked production alert, and record the fix approval." : "Create the hotfix Draft PR first so ShipBrain can review the actual fix commits before approval."}
        entityType="incident"
        entityId={selected?.id ?? "none"}
        details={
          selected && analysis ? (
            <div style={{ padding: "10px 0" }}>
              <div className="commit-context" style={{ padding: 8, background: "var(--bg)", border: "1px solid var(--line)", marginBottom: 12 }}>
                <div>
                  <span className="eyebrow mono" style={{ fontSize: 9 }}>Branch</span>
                  <strong>{selected.hotfixBranch ?? analysis.releaseContext?.featureBranch ?? selected.branch ?? "not linked"}</strong>
                </div>
                <div>
                  <span className="eyebrow mono" style={{ fontSize: 9 }}>PR target</span>
                  <strong>{selected.hotfixBaseBranch ?? analysis.releaseContext?.baseBranch ?? "develop"}</strong>
                </div>
              </div>
              <strong style={{ fontSize: 13 }}>{selected.hotfixPrNumber ? `Hotfix PR #${selected.hotfixPrNumber} commits ready to merge` : "Create hotfix PR before approval"}</strong>
              {selected.hotfixCommits?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, maxHeight: 150, overflow: "auto" }}>
                  {selected.hotfixCommits.slice(0, 6).map((commit) => (
                    <div key={commit.sha} style={{ display: "flex", gap: 10, fontSize: 12 }}>
                      <code className="mono" style={{ fontSize: 11, color: "var(--brand)" }}>{commit.shortSha ?? commit.sha.slice(0, 7)}</code>
                      <div>
                        <strong>{commit.message}</strong>
                        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>{commit.author ?? "GitHub"} · will merge automatically</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
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
