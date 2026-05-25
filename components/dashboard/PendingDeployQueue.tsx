"use client";

import { ExternalLink, GitPullRequest, Loader2, Play, RefreshCw, Rocket } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

type PendingDeploy = {
  id: string;
  queueType: "develop" | "production";
  stage: string;
  prNumber: number;
  prUrl: string;
  title: string;
  repo: string;
  branchName: string;
  baseBranch: string;
  deploymentStatus?: string;
  releaseStatus?: string;
  releasePrNumber?: number;
  releasePrUrl?: string;
  releasePrStatus?: string;
  releaseTag?: string;
  releaseSha?: string;
  previewUrl?: string;
  previewStatus?: string;
  previewBranchAlias?: string;
  productionUrl?: string;
  mergeSha?: string;
  mergedAt?: string;
  ciRunId?: string;
  updatedAt: string;
};

export function PendingDeployQueue() {
  const [pending, setPending] = useState<PendingDeploy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);

  useEffect(() => {
    void loadPending();
    const interval = window.setInterval(() => void loadPending(), 30000);
    return () => window.clearInterval(interval);
  }, []);

  async function loadPending() {
    try {
      const response = await fetch("/api/deployments/pending", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to load pending deployments");
      setPending(json);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load pending deployments");
    } finally {
      setLoading(false);
    }
  }

  async function refreshSpec(specId: string) {
    setRefreshing(specId);
    try {
      const response = await fetch("/api/specs/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specId })
      });
      if (!response.ok) {
        const json = await response.json();
        throw new Error(json.detail ?? json.error ?? "Unable to refresh");
      }
      await loadPending();
    } catch (nextError) {
      setActionErrors((prev) => ({
        ...prev,
        [specId]: nextError instanceof Error ? nextError.message : "Unable to refresh"
      }));
    } finally {
      setRefreshing(null);
    }
  }

  async function startPreviewDeploy(item: PendingDeploy) {
    setActionLoading(item.id);
    setActionErrors((prev) => ({ ...prev, [item.id]: "" }));
    try {
      const response = await fetch("/api/deployments/start-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specId: item.id })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to start preview deployment");
      await loadPending();
    } catch (nextError) {
      setActionErrors((prev) => ({
        ...prev,
        [item.id]: nextError instanceof Error ? nextError.message : "Unable to start preview deployment"
      }));
    } finally {
      setActionLoading(null);
    }
  }

  async function startProductionDeploy(item: PendingDeploy) {
    setActionLoading(item.id);
    setActionErrors((prev) => ({ ...prev, [item.id]: "" }));
    try {
      const response = await fetch("/api/deployments/start-production", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specId: item.id })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to start production deployment");
      await loadPending();
    } catch (nextError) {
      setActionErrors((prev) => ({
        ...prev,
        [item.id]: nextError instanceof Error ? nextError.message : "Unable to start production deployment"
      }));
    } finally {
      setActionLoading(null);
    }
  }

  function stageLabel(item: PendingDeploy) {
    switch (item.stage) {
      case "awaiting_preview": return "Awaiting Preview";
      case "preview_deploying": return "Preview Deploying";
      case "preview_ready": return "Preview Ready";
      case "release_pr_open": return "Release PR Open";
      case "pending_production_deploy": return "Ready for Production";
      case "deploying": return "Deploying...";
      case "deploy_failed": return "Deploy Failed";
      default: return item.stage;
    }
  }

  function stageClass(item: PendingDeploy) {
    if (item.stage === "preview_ready") return "green";
    if (item.stage === "deploy_failed") return "red";
    if (item.stage === "pending_production_deploy") return "amber";
    return "amber";
  }

  function stageCopy(item: PendingDeploy) {
    switch (item.stage) {
      case "awaiting_preview":
        return "Feature merged to develop. Click Start Preview to deploy to Vercel Preview environment.";
      case "preview_deploying":
        return "Preview deployment is in progress. The URL will appear when ready.";
      case "preview_ready":
        return "Preview is live! Test it, then create a Release PR to promote to production.";
      case "release_pr_open":
        return `Release PR #${item.releasePrNumber} is open. Merge it to proceed with production deployment.`;
      case "pending_production_deploy":
        return "Release PR is merged. Click Deploy to Production to create the release tag and deploy.";
      case "deploying":
        return "Production deployment is in progress...";
      case "deploy_failed":
        return "Production deployment failed. Check the workflow logs and retry.";
      default:
        return "";
    }
  }

  if (loading) {
    return (
      <div className="panel">
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ marginBottom: 0 }}>Deployment Queue</h2>
          <span className="status amber">Loading...</span>
        </div>
        <div className="loading-state" role="status">
          <span className="loading-spinner" aria-hidden="true" />
          <p>Checking for pending deployments...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel">
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ marginBottom: 0 }}>Deployment Queue</h2>
          <span className="status red">Error</span>
        </div>
        <div className="error-panel" role="alert">
          <strong>Unable to load queue</strong>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const developQueue = pending.filter(p => p.queueType === "develop");
  const productionQueue = pending.filter(p => p.queueType === "production");

  return (
    <div className="panel">
      <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ marginBottom: 0 }}>Deployment Queue</h2>
        <div className="toolbar" style={{ gap: 8 }}>
          <button className="button secondary compact" onClick={() => loadPending()} disabled={loading}>
            <RefreshCw size={14} />
            Refresh
          </button>
          <span className={`status ${pending.length > 0 ? "amber" : "green"}`}>
            {pending.length > 0 ? `${pending.length} pending` : "Queue empty"}
          </span>
        </div>
      </div>

      {pending.length === 0 ? (
        <div className="empty-state">
          <Rocket size={32} style={{ opacity: 0.5, marginBottom: 8 }} />
          <strong>No pending deployments</strong>
          <p>Merge a feature PR to develop to start the deployment flow.</p>
        </div>
      ) : (
        <div className="split-list">
          {/* Production Queue First */}
          {productionQueue.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Production</div>
              {productionQueue.map((item) => (
                <div className="card" key={item.id} style={{ marginBottom: 8 }}>
                  <div className="toolbar" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <strong>{item.title}</strong>
                      <p style={{ marginBottom: 0, fontSize: 13 }}>
                        {item.repo} · PR #{item.prNumber}
                        {item.releaseTag && <> · <code>{item.releaseTag}</code></>}
                      </p>
                    </div>
                    <span className={`status ${stageClass(item)}`}>{stageLabel(item)}</span>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, marginBottom: 0 }}>
                    {stageCopy(item)}
                  </p>
                  <div className="toolbar" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
                    {item.stage === "pending_production_deploy" && (
                      <button
                        className="button primary compact"
                        onClick={() => startProductionDeploy(item)}
                        disabled={actionLoading === item.id}
                      >
                        {actionLoading === item.id ? <Loader2 size={14} className="spin" /> : <Rocket size={14} />}
                        {actionLoading === item.id ? "Deploying..." : "Deploy to Production"}
                      </button>
                    )}
                    <button
                      className="button secondary compact"
                      onClick={() => refreshSpec(item.id)}
                      disabled={refreshing === item.id}
                    >
                      {refreshing === item.id ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      Sync
                    </button>
                    {item.prUrl && (
                      <a className="button secondary compact" href={item.prUrl} target="_blank" rel="noreferrer">
                        <GitPullRequest size={14} />
                        PR #{item.prNumber}
                      </a>
                    )}
                  </div>
                  {actionErrors[item.id] && (
                    <div className="error-panel" role="alert" style={{ marginTop: 8, padding: 8, fontSize: 12 }}>
                      {actionErrors[item.id]}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Develop Queue */}
          {developQueue.length > 0 && (
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Develop Preview</div>
              {developQueue.map((item) => (
                <div className="card" key={item.id} style={{ marginBottom: 8 }}>
                  <div className="toolbar" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <strong>{item.title}</strong>
                      <p style={{ marginBottom: 0, fontSize: 13 }}>
                        {item.repo} · PR #{item.prNumber} · {item.branchName} → {item.baseBranch}
                      </p>
                    </div>
                    <span className={`status ${stageClass(item)}`}>{stageLabel(item)}</span>
                  </div>
                  {item.mergedAt && (
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, marginBottom: 0 }}>
                      Merged {new Date(item.mergedAt).toLocaleString()}
                    </p>
                  )}
                  <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, marginBottom: 0 }}>
                    {stageCopy(item)}
                  </p>
                  {item.previewUrl && (
                    <div style={{ marginTop: 10, padding: 10, background: "var(--surface-elevated)", borderRadius: 6, border: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span className="status green" style={{ fontSize: 11 }}>Preview Live</span>
                      </div>
                      <a href={item.previewUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, wordBreak: "break-all" }}>
                        {item.previewUrl} <ExternalLink size={12} />
                      </a>
                    </div>
                  )}
                  <div className="toolbar" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
                    {item.stage === "awaiting_preview" && (
                      <button
                        className="button primary compact"
                        onClick={() => startPreviewDeploy(item)}
                        disabled={actionLoading === item.id}
                      >
                        {actionLoading === item.id ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                        {actionLoading === item.id ? "Starting..." : "Start Preview Deploy"}
                      </button>
                    )}
                    {item.stage === "preview_ready" && (
                      <>
                        <a className="button primary compact" href={item.previewUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} />
                          Open Preview
                        </a>
                        <Link className="button secondary compact" href="/spec-to-pr?template=develop-to-prod">
                          <Rocket size={14} />
                          Create Release PR
                        </Link>
                      </>
                    )}
                    {item.stage === "release_pr_open" && item.releasePrUrl && (
                      <a className="button primary compact" href={item.releasePrUrl} target="_blank" rel="noreferrer">
                        <GitPullRequest size={14} />
                        Review Release PR #{item.releasePrNumber}
                      </a>
                    )}
                    <button
                      className="button secondary compact"
                      onClick={() => refreshSpec(item.id)}
                      disabled={refreshing === item.id}
                    >
                      {refreshing === item.id ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      Sync
                    </button>
                    {item.prUrl && (
                      <a className="button secondary compact" href={item.prUrl} target="_blank" rel="noreferrer">
                        <GitPullRequest size={14} />
                        View PR
                      </a>
                    )}
                  </div>
                  {actionErrors[item.id] && (
                    <div className="error-panel" role="alert" style={{ marginTop: 8, padding: 8, fontSize: 12 }}>
                      {actionErrors[item.id]}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
