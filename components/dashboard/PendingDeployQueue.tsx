"use client";

import { Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { InputModal } from "@/components/ui/InputModal";

type IncludedFeature = {
  id: string;
  prNumber: number;
  prUrl: string;
  title: string;
  branchName: string;
  mergedAt?: string;
};

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
  linkedReleaseStatus?: string;
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
  // Consolidated features for preview_ready stage
  includedFeatures?: IncludedFeature[];
  featureCount?: number;
};

export function PendingDeployQueue() {
  const [pending, setPending] = useState<PendingDeploy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [redeployLoading, setRedeployLoading] = useState<string | null>(null);
  const [productionDeployTarget, setProductionDeployTarget] = useState<PendingDeploy | null>(null);

  useEffect(() => {
    void loadPending();
    
    // Determine if any item is actively deploying
    const hasActiveDeployments = pending.some(
      item => item.stage === "preview_deploying" || item.stage === "deploying"
    );
    const intervalTime = hasActiveDeployments ? 5000 : 20000;

    const interval = window.setInterval(() => void loadPending(), intervalTime);
    return () => window.clearInterval(interval);
  }, [pending]);

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

  function defaultReleaseTag() {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
    const time = now.toISOString().slice(11, 16).replace(":", "");
    return `release-v${date}-${time}`;
  }

  function openProductionDeployModal(item: PendingDeploy) {
    setActionErrors((prev) => ({ ...prev, [item.id]: "" }));
    setProductionDeployTarget(item);
  }

  async function startProductionDeploy(item: PendingDeploy, requestedReleaseTag?: string) {
    setActionLoading(item.id);
    setActionErrors((prev) => ({ ...prev, [item.id]: "" }));
    try {
      const response = await fetch("/api/deployments/start-production", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specId: item.id,
          releaseTag: requestedReleaseTag?.trim() || undefined
        })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to start production deployment");
      setProductionDeployTarget(null);
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

  async function redeployPreview(item: PendingDeploy) {
    setRedeployLoading(item.id);
    setActionErrors((prev) => ({ ...prev, [item.id]: "" }));
    try {
      const response = await fetch("/api/deployments/redeploy-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specId: item.id })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to redeploy preview");
      await loadPending();
    } catch (nextError) {
      setActionErrors((prev) => ({
        ...prev,
        [item.id]: nextError instanceof Error ? nextError.message : "Unable to redeploy preview"
      }));
    } finally {
      setRedeployLoading(null);
    }
  }

  async function redeployProduction(item: PendingDeploy) {
    setRedeployLoading(item.id);
    setActionErrors((prev) => ({ ...prev, [item.id]: "" }));
    try {
      const response = await fetch("/api/deployments/redeploy-production", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specId: item.id })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to redeploy production");
      await loadPending();
    } catch (nextError) {
      setActionErrors((prev) => ({
        ...prev,
        [item.id]: nextError instanceof Error ? nextError.message : "Unable to redeploy production"
      }));
    } finally {
      setRedeployLoading(null);
    }
  }

  function stageLabel(item: PendingDeploy) {
    switch (item.stage) {
      case "awaiting_preview": return "awaiting preview";
      case "preview_deploying": return "preview deploying";
      case "preview_ready": return "preview ready";
      case "release_pr_open": return "release pr open";
      case "hotfix_pr_open": return "hotfix pr open";
      case "pending_production_deploy": return "ready for production";
      case "deploying": return "deploying...";
      case "deploy_failed": return "deploy failed";
      default: return item.stage;
    }
  }

  function isStagePassed(item: PendingDeploy) {
    return item.stage === "preview_ready" || item.stage === "release_pr_open" || item.stage === "pending_production_deploy";
  }

  function stageCopy(item: PendingDeploy) {
    switch (item.stage) {
      case "awaiting_preview":
        if (item.featureCount && item.featureCount > 1) {
          return `${item.featureCount} features merged to develop. Click Start Preview to deploy all to Cloudflare Pages.`;
        }
        return "Feature merged to develop. Click Start Preview to deploy to Cloudflare Pages.";
      case "preview_deploying":
        if (item.featureCount && item.featureCount > 1) {
          return `Preview deployment for ${item.featureCount} features is in progress. The URL will appear when ready.`;
        }
        return "Preview deployment is in progress. The URL will appear when ready.";
      case "preview_ready":
        if (item.releasePrNumber && item.releasePrStatus === "merged") {
          return `Release PR #${item.releasePrNumber} is merged. Production deployment is waiting in the Production queue.`;
        }
        if (item.releasePrNumber) {
          return `Preview is live and Release PR #${item.releasePrNumber} already exists. Review or merge it before production deploy.`;
        }
        if (item.featureCount && item.featureCount > 1) {
          return `${item.featureCount} features are ready in develop. Create a Release PR to promote all to production.`;
        }
        return "Preview is live! Test it, then create a Release PR to promote to production.";
      case "release_pr_open":
        return `Release PR #${item.releasePrNumber} is open. Merge it to proceed with production deployment.`;
      case "hotfix_pr_open":
        return `Hotfix PR #${item.prNumber} is open. Review and approve the fix from Incident Commander before production deployment.`;
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
        <header className="panel-head">
          <h2>Deployment Queue</h2>
          <span className="badge-count">syncing</span>
        </header>
        <div className="loading-state" role="status" style={{ border: "none", background: "transparent" }}>
          <span className="loading-spinner" aria-hidden="true" />
          <p style={{ color: "var(--text-muted)", fontSize: "13px" }}>Checking deployment workflows...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel">
        <header className="panel-head">
          <h2>Deployment Queue</h2>
          <span className="badge-count" style={{ color: "var(--red)" }}>error</span>
        </header>
        <div className="error-panel" role="alert" style={{ margin: "14px 18px" }}>
          <strong>Unable to load queue</strong>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="panel">
      <header className="panel-head">
        <h2>
          Deployment Queue
          <span className="badge-count">{pending.length} pending</span>
        </h2>
        <div className="tools">
          <button className="ghost-btn" type="button" onClick={() => loadPending()} disabled={loading}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className={loading ? "spin" : ""}>
              <path d="M10 6a4 4 0 1 1-1.2-2.8L10 4.5M10 1.5V4.5H7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Refresh
          </button>
        </div>
      </header>

      {pending.length === 0 ? (
        <div className="empty-state" style={{ border: "none", background: "transparent" }}>
          <strong>No pending deployments</strong>
          <p style={{ color: "var(--text-muted)" }}>Merge a feature PR to develop to start the deployment flow.</p>
        </div>
      ) : (
        <div>
          {pending.map((item) => {
            const isProd = item.queueType === "production";
            const passed = isStagePassed(item);
            return (
              <div className="dq-card" key={item.id}>
                <div className="dq-head">
                  <div className="dq-head-left">
                    <span className="env-pill">{isProd ? "Production" : "Develop Preview"}</span>
                    <span className={`status-pill ${passed ? "passed" : item.stage === "deploy_failed" ? "danger" : ""}`}>
                      <span className="dot"></span>
                      {stageLabel(item)}
                    </span>
                  </div>
                  <div className="cloudflare-pill">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4 }}>
                      <path d="M16.5 6.4l-3.5 2.1L9.5 6.4 6 8.5v7l3.5 2.1 3.5-2.1 3.5 2.1 3.5-2.1v-7l-3.5-2.1z"/>
                    </svg>
                    Cloudflare
                  </div>
                </div>

                <div className="dq-title">{item.title}</div>
                <div className="dq-sub">
                  {item.repo} · PR #{item.prNumber} · {item.branchName} → {item.baseBranch}
                </div>

                <div className="dq-callout">
                  <svg className="ci" viewBox="0 0 14 14" fill="none" aria-hidden="true" width="14" height="14">
                    <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M4.5 7.2 6.3 9l3.2-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <div>
                    {stageCopy(item)}
                    {item.mergedAt && !item.includedFeatures?.length && (
                      <div className="merged-line mono">
                        merged {new Date(item.mergedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>

                {item.includedFeatures && item.includedFeatures.length > 1 && (
                  <div className="dq-features-list">
                    <div className="dq-features-header">Included features ({item.featureCount}):</div>
                    {item.includedFeatures.map((feature) => (
                      <div key={feature.id} className="dq-feature-item">
                        <a href={feature.prUrl} target="_blank" rel="noreferrer">
                          PR #{feature.prNumber}
                        </a>
                        <span className="dq-feature-title">{feature.title}</span>
                      </div>
                    ))}
                  </div>
                )}

                {item.previewUrl && (
                  <div className="dq-url">
                    <span className="live-dot" aria-hidden="true"></span>
                    <span className="mono" style={{ color: "var(--green)", textTransform: "lowercase" }}>preview live</span>
                    <span className="url" style={{ color: "var(--text-muted)" }}>{item.previewUrl}</span>
                    <a href={item.previewUrl} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center" }}>
                      <svg className="external" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M4 2h6v6M10 2 4 8M4 4v6h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </a>
                  </div>
                )}

                <div className="dq-actions">
                  {item.stage === "awaiting_preview" && (
                    <button
                      className="btn primary"
                      onClick={() => startPreviewDeploy(item)}
                      disabled={actionLoading === item.id}
                    >
                      {actionLoading === item.id && <Loader2 size={12} className="spin" style={{ marginRight: 4 }} />}
                      Start Preview Deploy
                    </button>
                  )}
                  {item.stage === "preview_ready" && item.previewUrl && (
                    <>
                      <a className="btn" href={item.previewUrl} target="_blank" rel="noreferrer">
                        Open Preview
                      </a>
                      <button
                        className="btn"
                        onClick={() => redeployPreview(item)}
                        disabled={redeployLoading === item.id}
                        title="Redeploy preview from develop branch"
                      >
                        {redeployLoading === item.id && <Loader2 size={12} className="spin" style={{ marginRight: 4 }} />}
                        <RefreshCw size={12} style={{ marginRight: 4 }} />
                        Redeploy
                      </button>
                      {item.releasePrNumber && item.releasePrUrl ? (
                        <a className="btn primary" href={item.releasePrUrl} target="_blank" rel="noreferrer">
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 4 }}>
                            <path d="M3 6h6M9 6l-2.5 2.5M9 6L6.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          Open Release PR #{item.releasePrNumber}
                        </a>
                      ) : item.releasePrNumber ? (
                        <button className="btn primary" disabled>
                          Release PR #{item.releasePrNumber} (draft)
                        </button>
                      ) : (
                        <Link className="btn primary" href="/spec-to-pr?template=develop-to-prod">
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 4 }}>
                            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          Create Release PR
                        </Link>
                      )}
                    </>
                  )}
                  {item.stage === "release_pr_open" && item.releasePrUrl && (
                    <a className="btn primary" href={item.releasePrUrl} target="_blank" rel="noreferrer">
                      Review Release PR #{item.releasePrNumber}
                    </a>
                  )}
                  {item.stage === "pending_production_deploy" && (
                    <button
                      className="btn primary"
                      onClick={() => openProductionDeployModal(item)}
                      disabled={actionLoading === item.id}
                    >
                      {actionLoading === item.id && <Loader2 size={12} className="spin" style={{ marginRight: 4 }} />}
                      Deploy to Production
                    </button>
                  )}
                  {item.stage === "hotfix_pr_open" && item.prUrl && (
                    <a className="btn primary" href={item.prUrl} target="_blank" rel="noreferrer">
                      Review Hotfix PR #{item.prNumber}
                    </a>
                  )}
                  {item.stage === "deploy_failed" && item.releaseTag && (
                    <button
                      className="btn primary"
                      onClick={() => redeployProduction(item)}
                      disabled={redeployLoading === item.id}
                      title="Retry production deployment"
                    >
                      {redeployLoading === item.id && <Loader2 size={12} className="spin" style={{ marginRight: 4 }} />}
                      <RefreshCw size={12} style={{ marginRight: 4 }} />
                      Retry Deploy
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => refreshSpec(item.id)}
                    disabled={refreshing === item.id}
                  >
                    {refreshing === item.id && <Loader2 size={12} className="spin" style={{ marginRight: 4 }} />}
                    Sync
                  </button>
                  {item.prUrl && (
                    <a className="btn subtle" href={item.prUrl} target="_blank" rel="noreferrer">
                      View PR
                    </a>
                  )}
                </div>

                {actionErrors[item.id] && (
                  <div className="error-panel" role="alert" style={{ marginTop: 12 }}>
                    <strong>Action Failed</strong>
                    <p>{actionErrors[item.id]}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
    <InputModal
      open={Boolean(productionDeployTarget)}
      title="Deploy to production"
      label="Release tag"
      placeholder={defaultReleaseTag()}
      defaultValue={productionDeployTarget?.releaseTag ?? defaultReleaseTag()}
      confirmLabel={actionLoading === productionDeployTarget?.id ? "Deploying..." : "Start Deployment"}
      cancelLabel="Cancel"
      required
      onClose={() => {
        if (actionLoading) return;
        setProductionDeployTarget(null);
      }}
      onConfirm={(value) => {
        if (!productionDeployTarget || actionLoading) return;
        void startProductionDeploy(productionDeployTarget, value);
      }}
    />
    </>
  );
}
