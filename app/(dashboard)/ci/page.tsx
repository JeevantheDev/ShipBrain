"use client";

import { CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, GitPullRequest, Loader2, Play, RefreshCw, Rocket, XCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { InputModal } from "@/components/ui/InputModal";

type CiRun = {
  id: string;
  specId?: string;
  specStatus?: string;
  prNumber?: number;
  prUrl?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  specTitle?: string;
  deploymentStatus?: string;
  releaseTag?: string;
  releaseStatus?: string;
  deploymentUrl?: string;
  previewUrl?: string;
  previewStatus?: string;
  previewBranchAlias?: string;
  productionUrl?: string;
  releasePrNumber?: number;
  releasePrUrl?: string;
  releasePrStatus?: string;
  releasePromotionPrNumber?: number;
  releasePromotionPrUrl?: string;
  isReleasePromotionPr?: boolean;
  incidentId?: string;
  incidentTitle?: string;
  incidentStatus?: string;
  incidentHotfixPrUrl?: string;
  incidentHotfixPrNumber?: number;
  isIncidentHotfix?: boolean;
  deploymentEligible?: boolean;
  repo?: string;
  branch: string;
  status: string;
  conclusion: string | null;
  title: string;
  workflowName?: string;
  htmlUrl?: string;
  updatedAt?: string;
  logs: string;
};

type RepoSecretState = {
  id: string;
  full_name: string;
  setup_metadata?: { skipVercel?: boolean; vercelSettingsUrl?: string };
  vercel_preview_env_confirmed?: boolean;
};

type DeploymentAudit = {
  id: string;
  action: "deploy_approved" | "deploy_rejected";
  note?: string | null;
  createdAt: string;
  metadata: {
    repo?: string;
    branch?: string;
    conclusion?: string;
    simulation?: boolean;
    releaseTag?: string;
    releaseUrl?: string;
    deploymentWorkflowUrl?: string;
    deploymentState?: string;
    releasePrNumber?: number;
    releasePrUrl?: string;
    releasePrMode?: "create_pr" | "merge_existing_pr";
    releaseSha?: string;
    previewWorkflowUrl?: string;
    previewUrl?: string | null;
    previewStatus?: string | null;
    previewBranchAlias?: string | null;
  };
};

type PendingDeploy = {
  id: string;
  queueType: "develop" | "production";
  stage: string;
  prNumber?: number;
  prUrl?: string;
  title: string;
  repo: string;
  branchName: string;
  baseBranch: string;
  previewUrl?: string;
  previewStatus?: string;
  previewBranchAlias?: string;
  releaseTag?: string;
  releaseSha?: string;
  linkedReleaseStatus?: string;
  releasePrNumber?: number;
  releasePrUrl?: string;
  releasePrStatus?: string;
  updatedAt: string;
};

const vercelDashboardUrl = "https://vercel.com/dashboard";

function safeVercelSettingsUrl(value?: string | null) {
  if (!value || value.includes("/dashboard/project/")) return vercelDashboardUrl;
  return value;
}

function defaultReleaseTag() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `cart-v${date}-${time}-${suffix}`;
}

export default function CiPage() {
  const searchParams = useSearchParams();
  const requestedRunId = searchParams.get("run");
  const [runs, setRuns] = useState<CiRun[]>([]);
  const [selected, setSelected] = useState<CiRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deploymentBusy, setDeploymentBusy] = useState(false);
  const [deploymentMessage, setDeploymentMessage] = useState("");
  const [deploymentError, setDeploymentError] = useState("");
  const [audits, setAudits] = useState<DeploymentAudit[]>([]);
  const [releaseTag, setReleaseTag] = useState("");
  const [repos, setRepos] = useState<RepoSecretState[]>([]);
  const [pendingDeploys, setPendingDeploys] = useState<PendingDeploy[]>([]);
  const [previewDismissed, setPreviewDismissed] = useState(false);
  const [queueActionLoading, setQueueActionLoading] = useState<string | null>(null);
  const [queueActionErrors, setQueueActionErrors] = useState<Record<string, string>>({});
  const [productionDeployTarget, setProductionDeployTarget] = useState<PendingDeploy | null>(null);
  const [releasePrTarget, setReleasePrTarget] = useState<PendingDeploy | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalRuns, setTotalRuns] = useState(0);
  const pageSize = 10;
  const selectedHasRejectionAudit = selected ? audits.some((audit) => audit.action === "deploy_rejected") : false;
  const previewRepo = repos.find((repo) => !repo.vercel_preview_env_confirmed && !repo.setup_metadata?.skipVercel);
  useEffect(() => {
    void loadRuns();
    void loadRepos();
    void loadPendingDeploys();
    const interval = window.setInterval(() => {
      void loadRuns();
      void loadPendingDeploys();
    }, 15000);
    const handleRefetch = () => {
      void loadRuns();
      void loadRepos();
      void loadPendingDeploys();
    };
    window.addEventListener("shipbrain-refetch", handleRefetch);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("shipbrain-refetch", handleRefetch);
    };
  }, []);

  async function loadRuns(page = currentPage) {
    try {
      const query = requestedRunId
        ? `run=${encodeURIComponent(requestedRunId)}`
        : `page=${page}&limit=${pageSize}`;
      const response = await fetch(`/api/ci-runs?${query}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to load CI runs");
      setRuns(json.runs ?? []);
      setTotalPages(json.pagination?.totalPages ?? 1);
      setTotalRuns(json.pagination?.total ?? 0);
      setCurrentPage(json.pagination?.page ?? 1);
      setError("");
      setSelected((current) => {
        if (requestedRunId) return (json.runs ?? []).find((run: CiRun) => run.id === requestedRunId) ?? current;
        if (!current) return current;
        return (json.runs ?? []).find((run: CiRun) => run.id === current.id) ?? current;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load CI runs");
    } finally {
      setLoading(false);
    }
  }

  function goToPage(page: number) {
    if (page < 1 || page > totalPages) return;
    setCurrentPage(page);
    void loadRuns(page);
  }

  async function loadRepos() {
    const response = await fetch("/api/settings/secrets", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    setRepos(await response.json());
  }

  async function loadPendingDeploys() {
    const response = await fetch("/api/deployments/pending", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    setPendingDeploys(await response.json());
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
      await loadPendingDeploys();
      await loadRuns();
    } catch (nextError) {
      setQueueActionErrors((prev) => ({
        ...prev,
        [specId]: nextError instanceof Error ? nextError.message : "Unable to refresh"
      }));
    } finally {
      setRefreshing(null);
    }
  }

  function stageLabel(item: PendingDeploy) {
    switch (item.stage) {
      case "awaiting_preview": return "Awaiting Preview";
      case "awaiting_validation": return "Awaiting Preview";
      case "preview_deploying": return "Preview Deploying";
      case "preview_ready": return "Preview Ready";
      case "release_pr_open": return "Release PR Open";
      case "hotfix_pr_open": return "Hotfix PR Open";
      case "pending_production_deploy": return "Ready for Production";
      case "deploying": return "Deploying...";
      case "deploy_failed": return "Deploy Failed";
      default: return item.stage;
    }
  }

  function stageClass(item: PendingDeploy) {
    if (item.stage === "preview_ready") return "passed";
    if (item.stage === "deploy_failed") return "danger";
    return "";
  }

  function stageCopy(item: PendingDeploy) {
    switch (item.stage) {
      case "awaiting_preview":
      case "awaiting_validation":
        return "Feature merged to develop. Click Start Preview to deploy to Cloudflare Pages.";
      case "preview_deploying":
        return "Preview deployment is in progress. The URL will appear when ready.";
      case "preview_ready":
        if (item.releasePrNumber && item.releasePrStatus === "merged") {
          return `Release PR #${item.releasePrNumber} is merged. Production deployment is waiting in the Production queue.`;
        }
        if (item.releasePrNumber) {
          return `Preview is live and Release PR #${item.releasePrNumber} already exists. Review or merge it before production deploy.`;
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

  function openProductionDeployModal(item: PendingDeploy) {
    setQueueActionErrors((prev) => ({ ...prev, [item.id]: "" }));
    setProductionDeployTarget(item);
  }

  async function startProductionDeploy(item: PendingDeploy, requestedReleaseTag?: string) {
    setQueueActionLoading(item.id);
    setQueueActionErrors((prev) => ({ ...prev, [item.id]: "" }));
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
      await loadPendingDeploys();
      await loadRuns();
    } catch (nextError) {
      setQueueActionErrors((prev) => ({
        ...prev,
        [item.id]: nextError instanceof Error ? nextError.message : "Unable to start production deployment"
      }));
    } finally {
      setQueueActionLoading(null);
    }
  }

  async function startPreviewDeploy(item: PendingDeploy) {
    setQueueActionLoading(item.id);
    setQueueActionErrors((prev) => ({ ...prev, [item.id]: "" }));
    try {
      const response = await fetch("/api/deployments/start-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specId: item.id })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to start preview deployment");
      await loadPendingDeploys();
      await loadRuns();
      if (json.ciRunId) {
        const runResponse = await fetch(`/api/ci-runs?run=${encodeURIComponent(String(json.ciRunId))}`, { cache: "no-store" }).catch(() => null);
        const runJson = await runResponse?.json().catch(() => null);
        const run = runJson?.runs?.[0] as CiRun | undefined;
        if (run) {
          setRuns((items) => [run, ...items.filter((item) => item.id !== run.id)]);
          setSelected(run);
        }
      }
    } catch (nextError) {
      setQueueActionErrors((prev) => ({
        ...prev,
        [item.id]: nextError instanceof Error ? nextError.message : "Unable to start preview deployment"
      }));
    } finally {
      setQueueActionLoading(null);
    }
  }

  async function confirmPreviewEnv(repoId: string) {
    await fetch("/api/settings/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, action: "confirm_preview_env" })
    }).catch(() => undefined);
    setPreviewDismissed(true);
    await loadRepos();
  }

  function statusClass(run: CiRun) {
    if (run.conclusion === "success") return "passed";
    if (run.conclusion || run.status === "completed") return "danger";
    return "";
  }

  function getEnvironment(run: CiRun): "PROD" | "DEV" | "CI" | null {
    const name = (run.workflowName ?? run.title).toLowerCase();
    if (name.includes("preview") || run.branch === "develop") return "DEV";
    if (name.includes("production") || name.includes("prod deploy") || run.branch === "main") return "PROD";
    if (name.includes("ci") || name.includes("test") || name.includes("lint")) return "CI";
    return null;
  }

  function envClass(env: "PROD" | "DEV" | "CI" | null) {
    if (env === "PROD") return "prod-env";
    if (env === "DEV") return "dev-env";
    if (env === "CI") return "ci-env";
    return "";
  }

  function selectRun(run: CiRun) {
    setSelected(run);
    setReleaseTag(run.releaseTag ?? defaultReleaseTag());
    setDeploymentMessage("");
    setDeploymentError("");
    if (shouldShowDeploymentAudit(run)) {
      void loadAudits(run);
    } else {
      setAudits([]);
    }
  }

  function runSummary(run: CiRun) {
    if (run.isIncidentHotfix) return "This workflow is attached to an incident hotfix. Production deployment is controlled from Incident Commander, not the CI Approve Deploy gate.";
    if (run.releaseStatus === "deploying") return "Production release is in progress. ShipBrain is tracking the Vercel workflow and will mark this deployed when GitHub reports a successful production run.";
    if (run.releaseStatus === "deployed") return "Production release completed successfully.";
    if (run.releaseStatus === "failed") return "Production release failed. Open the deployment workflow to inspect the failure before retrying.";
    if (run.releaseStatus === "pending_deploy") return "This release PR is merged and waiting for production deployment. Click 'Tag & Deploy' to create the release tag and dispatch the Vercel production workflow.";
    if (run.isReleasePromotionPr && run.deploymentEligible) return "This green release PR is ready for manager approval. Click 'Merge, tag, deploy' to merge, create the release tag, and dispatch the Vercel production workflow.";
    if (run.releasePrNumber) return `Release PR #${run.releasePrNumber} is already tracking production promotion.`;
    if (run.branch !== "develop") return "This run is not a production approval gate. Main/release/deployment workflow runs are tracked for visibility only.";
    if (run.conclusion === "success" && run.specStatus !== "merged") return "CI is green, but production approval waits until the development team reviews and merges the PR into develop.";
    if (run.deploymentEligible) return "This develop validation run is eligible for validation and audit.";
    if (run.conclusion === "success") return "This workflow completed successfully, but it is not the active production approval gate.";
    if (run.conclusion) return "This workflow completed with a non-success conclusion. Review details or ask ShipBrain to explain it.";
    return "This workflow is still running or queued. ShipBrain will update it as GitHub sends more webhook events.";
  }

  async function loadAudits(run: CiRun) {
    try {
      const params = new URLSearchParams(run.specId ? { specId: run.specId } : { entityId: run.id });
      const response = await fetch(`/api/deployments/approval?${params.toString()}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to load deployment audit trail");
      setAudits(json);
    } catch (nextError) {
      setDeploymentError(nextError instanceof Error ? nextError.message : "Unable to load deployment audit trail");
    }
  }

  function shouldShowDeploymentAudit(run: CiRun) {
    return (
      run.deploymentStatus === "develop_validated" ||
      run.releaseStatus === "ready_for_prod" ||
      run.workflowName === "ShipBrain Production Deploy" ||
      run.workflowName === "ShipBrain Vercel Production Deploy" ||
      run.releaseStatus === "deploying" ||
      run.releaseStatus === "deployed" ||
      run.releaseStatus === "failed"
    );
  }

  async function recordDeploymentDecision(action: DeploymentAudit["action"], note: string) {
    if (!selected) return;
    setDeploymentBusy(true);
    setDeploymentError("");
    setDeploymentMessage("");
    try {
      const response = await fetch("/api/deployments/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: selected.id, action, note, releaseTag })
      });
      const json = await response.json();
      if (!response.ok) throw new Error([json.error, json.detail].filter(Boolean).join(" "));

      const isAuditOnly = json.metadata?.auditOnly === true;
      const approvedState = isAuditOnly
        ? "ready_for_prod"
        : json.metadata?.deploymentState === "dispatch_started"
          ? "deploying"
          : "release_pr_open";
      const approvedUrl = json.metadata?.deploymentWorkflowUrl ?? json.metadata?.releasePrUrl;

      setAudits((items) => [json, ...items].slice(0, 10));
      setSelected((current) => current ? {
        ...current,
        deploymentStatus: action === "deploy_approved" ? (isAuditOnly ? "develop_validated" : "approved") : "rejected",
        deploymentEligible: false,
        releaseTag: json.metadata?.releaseTag ?? (isAuditOnly ? undefined : releaseTag),
        releaseStatus: action === "deploy_approved" ? approvedState : "rejected",
        releasePrNumber: json.metadata?.releasePrNumber,
        releasePrUrl: json.metadata?.releasePrUrl,
        releasePrStatus: action === "deploy_approved" ? (approvedState === "deploying" ? "merged" : isAuditOnly ? undefined : "open") : "rejected",
        deploymentUrl: approvedUrl,
        previewStatus: isAuditOnly ? "deploying" : current.previewStatus,
        previewUrl: json.metadata?.previewUrl ?? current.previewUrl,
        previewBranchAlias: json.metadata?.previewBranchAlias ?? current.previewBranchAlias
      } : current);
      setRuns((items) => items.map((run) => run.id === selected.id ? {
        ...run,
        deploymentStatus: action === "deploy_approved" ? (isAuditOnly ? "develop_validated" : "approved") : "rejected",
        deploymentEligible: false,
        releaseTag: json.metadata?.releaseTag ?? (isAuditOnly ? undefined : releaseTag),
        releaseStatus: action === "deploy_approved" ? approvedState : "rejected",
        releasePrNumber: json.metadata?.releasePrNumber,
        releasePrUrl: json.metadata?.releasePrUrl,
        releasePrStatus: action === "deploy_approved" ? (approvedState === "deploying" ? "merged" : isAuditOnly ? undefined : "open") : "rejected",
        deploymentUrl: approvedUrl,
        previewStatus: isAuditOnly ? "deploying" : run.previewStatus,
        previewUrl: json.metadata?.previewUrl ?? run.previewUrl,
        previewBranchAlias: json.metadata?.previewBranchAlias ?? run.previewBranchAlias
      } : run));

      if (action !== "deploy_approved") {
        setDeploymentMessage("Deployment rejection recorded.");
      } else if (isAuditOnly) {
        setDeploymentMessage("Develop branch CI validated and audited. ShipBrain started the Vercel Preview deployment for develop. No release tag was created.");
      } else if (json.metadata?.deploymentState === "dispatch_started") {
        setDeploymentMessage(`Release PR #${json.metadata?.releasePrNumber ?? ""} merged. Tag ${json.metadata?.releaseTag ?? releaseTag} was created and Vercel production deploy was dispatched.`);
      } else {
        setDeploymentMessage(`Release PR #${json.metadata?.releasePrNumber ?? ""} created from develop to main. Merge it to create the release tag and start Vercel production deploy.`);
      }
      setGateOpen(false);
    } catch (nextError) {
      setDeploymentError(nextError instanceof Error ? nextError.message : "Unable to record deployment decision");
    } finally {
      setDeploymentBusy(false);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow mono">
            <span className="bar"></span>
            <span className="pillar-tag">Pillar 02</span>
            CI Intelligence
          </div>
          <h1>Realtime CI run cards and gated release control.</h1>
          <div className="sub">
            Plain-English workflow failure diagnosis, automated previews, and production release gating.
          </div>
        </div>
      </header>

      {/* Cloudflare Pages handles environment variables automatically via ShipBrain setup */}

      <section className="ci-monitor-layout">
        <div className="ci-monitor-main">
          <section className="panel">
          <header className="panel-head">
            <h2>
              Deployment Queue
              <span className="badge-count">{pendingDeploys.length} runs</span>
            </h2>
            <div className="tools">
              <button className="btn subtle" onClick={() => void loadPendingDeploys()} disabled={loading}>
                <RefreshCw size={12} className={loading ? "spin" : ""} style={{ marginRight: 4 }} />
                Refresh
              </button>
            </div>
          </header>

          {pendingDeploys.length === 0 ? (
            <div style={{ padding: "36px", textAlign: "center", color: "var(--text-muted)" }}>
              <Rocket size={32} style={{ opacity: 0.5, marginBottom: 8, marginInline: "auto" }} />
              <strong>No pending deployments</strong>
              <p style={{ fontSize: 13, marginTop: 4 }}>Merge a feature PR to develop to start the deployment flow.</p>
            </div>
          ) : (
            <div style={{ padding: 12 }}>
              {/* Production Queue First */}
              {pendingDeploys.filter(p => p.queueType === "production").length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div className="eyebrow mono" style={{ marginBottom: 8, fontSize: "11px" }}>Production</div>
                  {pendingDeploys.filter(p => p.queueType === "production").map((item) => (
                    <div className="card" key={item.id} style={{ marginBottom: 8, padding: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <strong style={{ fontSize: "13.5px" }}>{item.title}</strong>
                          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                            {item.repo} · PR #{item.prNumber}
                            {item.releaseTag && <> · <code>{item.releaseTag}</code></>}
                          </p>
                        </div>
                        <span className={`status-pill ${stageClass(item)}`}>
                          <span className="dot"></span>
                          {stageLabel(item)}
                        </span>
                      </div>
                      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, marginBottom: 0 }}>
                        {stageCopy(item)}
                      </p>
                      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                        {item.stage === "pending_production_deploy" && (
                          <button
                            className="btn-primary"
                            onClick={() => openProductionDeployModal(item)}
                            disabled={queueActionLoading === item.id}
                          >
                            {queueActionLoading === item.id ? <Loader2 size={12} className="spin" /> : <Rocket size={12} />}
                            {queueActionLoading === item.id ? "Deploying..." : "Deploy to Production"}
                          </button>
                        )}
                        {item.stage === "hotfix_pr_open" && item.prUrl && (
                          <a className="btn-primary" href={item.prUrl} target="_blank" rel="noreferrer">
                            <GitPullRequest size={12} />
                            Review Hotfix PR #{item.prNumber}
                          </a>
                        )}
                        <button
                          className="btn subtle"
                          onClick={() => refreshSpec(item.id)}
                          disabled={refreshing === item.id}
                        >
                          {refreshing === item.id ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                          Sync
                        </button>
                        {item.prUrl && (
                          <a className="btn subtle" href={item.prUrl} target="_blank" rel="noreferrer">
                            <GitPullRequest size={12} />
                            PR #{item.prNumber}
                          </a>
                        )}
                      </div>
                      {queueActionErrors[item.id] && (
                        <div className="error-panel" role="alert" style={{ marginTop: 8, padding: 8, fontSize: 12 }}>
                          {queueActionErrors[item.id]}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Develop Queue */}
              {pendingDeploys.filter(p => p.queueType === "develop").length > 0 && (
                <div>
                  <div className="eyebrow mono" style={{ marginBottom: 8, fontSize: "11px" }}>Develop Preview</div>
                  {pendingDeploys.filter(p => p.queueType === "develop").map((item) => (
                    <div className="card" key={item.id} style={{ marginBottom: 8, padding: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <strong style={{ fontSize: "13.5px" }}>{item.title}</strong>
                          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                            {item.repo} · PR #{item.prNumber} · {item.branchName} → {item.baseBranch}
                          </p>
                        </div>
                        <span className={`status-pill ${stageClass(item)}`}>
                          <span className="dot"></span>
                          {stageLabel(item)}
                        </span>
                      </div>
                      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, marginBottom: 0 }}>
                        {stageCopy(item)}
                      </p>
                      {item.previewUrl && (
                        <div style={{ marginTop: 10, padding: 10, background: "var(--panel-2)", borderRadius: 6, border: "1px solid var(--line)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            <span className="status-pill passed" style={{ fontSize: 11 }}>Preview Live</span>
                          </div>
                          <a href={item.previewUrl} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                            {item.previewUrl} <ExternalLink size={10} style={{ marginLeft: 4 }} />
                          </a>
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                        {(item.stage === "awaiting_preview" || item.stage === "awaiting_validation") && (
                          <button
                            className="btn-primary"
                            onClick={() => startPreviewDeploy(item)}
                            disabled={queueActionLoading === item.id}
                          >
                            {queueActionLoading === item.id ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                            {queueActionLoading === item.id ? "Starting..." : "Start Preview Deploy"}
                          </button>
                        )}
                        {item.stage === "preview_ready" && (
                          <>
                            <a className="btn-primary" href={item.previewUrl} target="_blank" rel="noreferrer">
                              <ExternalLink size={12} />
                              Open Preview
                            </a>
                            <button className="btn subtle" onClick={() => setReleasePrTarget(item)}>
                              {item.releasePrNumber ? <GitPullRequest size={12} /> : <Rocket size={12} />}
                              {item.releasePrNumber ? "Release PR Status" : "Promote to Production"}
                            </button>
                          </>
                        )}
                        {item.stage === "release_pr_open" && item.releasePrUrl && (
                          <a className="btn-primary" href={item.releasePrUrl} target="_blank" rel="noreferrer">
                            <GitPullRequest size={12} />
                            Review Release PR #{item.releasePrNumber}
                          </a>
                        )}
                        <button
                          className="btn subtle"
                          onClick={() => refreshSpec(item.id)}
                          disabled={refreshing === item.id}
                        >
                          {refreshing === item.id ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                          Sync
                        </button>
                        {item.prUrl && (
                          <a className="btn subtle" href={item.prUrl} target="_blank" rel="noreferrer">
                            <GitPullRequest size={12} />
                            View PR
                          </a>
                        )}
                      </div>
                      {queueActionErrors[item.id] && (
                        <div className="error-panel" role="alert" style={{ marginTop: 8, padding: 8, fontSize: 12 }}>
                          {queueActionErrors[item.id]}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          </section>

          <section className="panel">
          <header className="panel-head">
            <h2>
              Workflow Runs
              <span className="badge-count">{totalRuns} total</span>
            </h2>
            <div className="tools">
              <button className="btn subtle" onClick={() => void loadRuns()} disabled={loading}>
                Refresh
              </button>
            </div>
          </header>

          <div style={{ padding: 12 }}>
            {error ? (
              <div className="error-panel" role="alert" style={{ marginBottom: 12 }}>
                <strong>CI sync needs attention</strong>
                <p>{error}</p>
              </div>
            ) : null}

            {loading ? (
              <div style={{ padding: 36, textAlign: "center", color: "var(--text-muted)" }}>
                <span className="loading-spinner" style={{ marginInline: "auto", marginBottom: 8 }} />
                <strong>Loading workflow runs</strong>
                <p style={{ fontSize: 12 }}>Checking database for GitHub Actions webhook events.</p>
              </div>
            ) : runs.length ? (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {runs.map((run) => {
                    const env = getEnvironment(run);
                    const hasFailed = run.conclusion && run.conclusion !== "success";
                    const isSel = selected?.id === run.id;
                    return (
                      <button
                        className={`card pr-row ${hasFailed ? "error-highlight" : ""}`}
                        key={run.id}
                        style={{
                          textAlign: "left",
                          cursor: "pointer",
                          borderColor: isSel ? "var(--brand)" : hasFailed ? "var(--red)" : undefined,
                          background: isSel ? "var(--panel-2)" : undefined,
                          width: "100%"
                        }}
                        onClick={() => selectRun(run)}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <strong style={{ fontSize: 13.5, color: "var(--text)" }}>{run.title}</strong>
                            {env && (
                              <span className={`status-pill ${envClass(env)}`} style={{ fontSize: 10, padding: "1px 5px" }}>
                                {env}
                              </span>
                            )}
                          </div>
                          <span className={`status-pill ${statusClass(run)}`}>
                            <span className="dot"></span>
                            {run.conclusion ?? run.status}
                          </span>
                        </div>
                        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                          <span style={{ color: "var(--text-secondary)" }}>{run.repo ?? "GitHub"}</span> · <span style={{ color: "var(--brand)" }}>{run.branch}</span>
                          {run.prNumber ? <> · <span style={{ color: "var(--text-secondary)" }}>PR #{run.prNumber}</span></> : ""}
                          {run.updatedAt ? <> · <span style={{ color: "var(--text-muted)" }}>{new Date(run.updatedAt).toLocaleTimeString()}</span></> : ""}
                        </p>
                        {hasFailed && (
                          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 4, color: "var(--red)", fontSize: 11 }}>
                            <XCircle size={10} />
                            Failed — click to analyze logs
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, padding: "12px 0", borderTop: "1px solid var(--line-muted)" }}>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      Showing {((currentPage - 1) * pageSize) + 1}-{Math.min(currentPage * pageSize, totalRuns)} of {totalRuns}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        className="btn subtle"
                        onClick={() => goToPage(currentPage - 1)}
                        disabled={currentPage <= 1}
                        style={{ padding: "6px" }}
                      >
                        <ChevronLeft size={14} />
                      </button>
                      {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                        let pageNum: number;
                        if (totalPages <= 5) {
                          pageNum = i + 1;
                        } else if (currentPage <= 3) {
                          pageNum = i + 1;
                        } else if (currentPage >= totalPages - 2) {
                          pageNum = totalPages - 4 + i;
                        } else {
                          pageNum = currentPage - 2 + i;
                        }
                        return (
                          <button
                            key={pageNum}
                            className={`btn ${currentPage === pageNum ? "primary" : "subtle"}`}
                            onClick={() => goToPage(pageNum)}
                            style={{ padding: "4px 10px", minWidth: 28, fontSize: 11 }}
                          >
                            {pageNum}
                          </button>
                        );
                      })}
                      <button
                        className="btn subtle"
                        onClick={() => goToPage(currentPage + 1)}
                        disabled={currentPage >= totalPages}
                        style={{ padding: "6px" }}
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ padding: "36px", textAlign: "center", color: "var(--text-muted)" }}>
                <strong>No CI runs received</strong>
                <p style={{ fontSize: 12, marginTop: 4 }}>Configure the GitHub webhook for the connected repo.</p>
              </div>
            )}
          </div>
          </section>
        </div>

        <aside className="panel ci-workflow-details">
          <header className="panel-head">
            <h2>Workflow Details</h2>
          </header>
          <div style={{ padding: 16 }}>
            {selected ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div>
                    <strong style={{ fontSize: 14 }}>{selected.title}</strong>
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                      {selected.repo ?? "GitHub"} · {selected.branch} · run #{selected.id}
                    </p>
                    {selected.prNumber ? (
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                        {selected.isReleasePromotionPr ? "Release PR" : "Generated from Draft PR"} #{selected.prNumber}
                        {selected.specTitle ? ` · ${selected.specTitle}` : ""}
                        {selected.specStatus ? ` · ${selected.specStatus}` : ""}
                      </p>
                    ) : (
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Not linked to a ShipBrain Draft PR.</p>
                    )}
                  </div>
                  <span className={`status-pill ${statusClass(selected)}`}>
                    <span className="dot"></span>
                    {selected.conclusion ?? selected.status}
                  </span>
                </div>

                <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>{runSummary(selected)}</p>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                  {selected.deploymentStatus === "develop_validated" && <span className="status-pill passed"><span className="dot"></span>Develop CI validated</span>}
                  {selected.deploymentStatus === "approved" && <span className="status-pill passed"><span className="dot"></span>Production approved</span>}
                  {selected.deploymentStatus === "rejected" && selectedHasRejectionAudit && <span className="status-pill danger"><span className="dot"></span>Deployment rejected</span>}
                  {selected.releaseTag && <span className="status-pill passed"><span className="dot"></span>Release {selected.releaseTag}</span>}
                  {selected.releaseStatus && (
                    <span className={`status-pill ${selected.releaseStatus === "failed" ? "danger" : selected.releaseStatus === "deployed" ? "passed" : ""}`}>
                      <span className="dot"></span>
                      {selected.releaseStatus === "release_pr_open"
                        ? "Release PR open"
                        : selected.releaseStatus === "deploying"
                          ? "Release in progress"
                          : selected.releaseStatus === "deployed"
                            ? "Production deployed"
                            : selected.releaseStatus === "failed"
                              ? "Release failed"
                              : selected.releaseStatus}
                    </span>
                  )}
                  {selected.isReleasePromotionPr && <span className="status-pill"><span className="dot"></span>Release gate</span>}
                </div>

                {selected.isIncidentHotfix && (
                  <div className="success-panel" role="status" style={{ marginBottom: 12 }}>
                    <strong>Linked incident hotfix</strong>
                    <p style={{ margin: 0, fontSize: 12 }}>
                      {selected.incidentTitle ?? "Incident fix"} · {selected.incidentStatus ?? "tracking"}
                      {selected.incidentHotfixPrNumber ? ` · Hotfix PR #${selected.incidentHotfixPrNumber}` : ""}
                    </p>
                  </div>
                )}

                {selected.conclusion && selected.conclusion !== "success" && (
                  <div className="error-panel" role="alert" style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <XCircle size={14} style={{ color: "var(--red)" }} />
                      <strong style={{ color: "var(--red)", fontSize: 13 }}>Workflow Failed</strong>
                      {getEnvironment(selected) && (
                        <span className={`status-pill ${envClass(getEnvironment(selected))}`} style={{ marginLeft: "auto" }}>
                          <span className="dot"></span>
                          {getEnvironment(selected)}
                        </span>
                      )}
                    </div>
                    <p style={{ fontSize: 12, margin: "0 0 6px" }}>
                      Completed with: <code>{selected.conclusion}</code> {selected.workflowName ? ` (${selected.workflowName})` : ""}
                    </p>
                  </div>
                )}

                <div className="code-view-container" style={{ position: "relative", marginBottom: 14 }}>
                  <pre className="code-view mono" style={{
                    maxHeight: 180,
                    fontSize: 11.5,
                    padding: 10,
                    background: "var(--panel-2)",
                    border: "1px solid var(--line)",
                    borderColor: selected.conclusion && selected.conclusion !== "success" ? "var(--red)" : undefined
                  }}>{selected.logs}</pre>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {selected.htmlUrl && (
                    <a className="btn subtle" href={selected.htmlUrl} target="_blank" rel="noreferrer" style={{ flex: 1, justifyContent: "center" }}>
                      <ExternalLink size={12} />
                      GitHub
                    </a>
                  )}
                  {selected.deploymentUrl && (
                    <a className="btn subtle" href={selected.deploymentUrl} target="_blank" rel="noreferrer" style={{ flex: 1, justifyContent: "center" }}>
                      <ExternalLink size={12} />
                      {selected.releasePrNumber ? `Release PR #${selected.releasePrNumber}` : "Deploy"}
                    </a>
                  )}
                  {selected.releasePromotionPrUrl && (
                    <a className="btn subtle" href={selected.releasePromotionPrUrl} target="_blank" rel="noreferrer" style={{ flex: 1, justifyContent: "center" }}>
                      <ExternalLink size={12} />
                      Release PR
                    </a>
                  )}
                </div>

                {selected.previewUrl || selected.previewStatus ? (
                  <div className="info-callout" style={{ marginTop: 14 }}>
                    <strong>Preview {selected.previewStatus === "deploying" ? "deploying" : selected.previewUrl ? "ready" : "pending"}</strong>
                    <p style={{ margin: "4px 0" }}>
                      {selected.previewUrl ? <>URL <a href={selected.previewUrl} target="_blank" rel="noreferrer">{selected.previewUrl}</a></> : "ShipBrain started the preview deploy. The URL will appear here after GitHub Actions reports it."}
                      {selected.previewBranchAlias ? <> · Branch alias <a href={selected.previewBranchAlias.startsWith("http") ? selected.previewBranchAlias : `https://${selected.previewBranchAlias}`} target="_blank" rel="noreferrer">{selected.previewBranchAlias}</a></> : null}
                    </p>
                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 11 }}>Deployed to Cloudflare Pages.</p>
                  </div>
                ) : null}

                {deploymentMessage && (
                  <div className="success-panel" role="status" style={{ marginTop: 14 }}>
                    <strong>Deployment gate updated</strong>
                    <p style={{ margin: 0 }}>{deploymentMessage}</p>
                  </div>
                )}
                {deploymentError && (
                  <div className="error-panel" role="alert" style={{ marginTop: 14 }}>
                    <strong>Deployment gate needs attention</strong>
                    <p style={{ margin: 0 }}>{deploymentError}</p>
                  </div>
                )}
              </>
            ) : (
              <div style={{ padding: "36px", textAlign: "center", color: "var(--text-muted)" }}>
                <strong>Select a workflow run</strong>
                <p style={{ fontSize: 12, marginTop: 4 }}>Click any run to inspect details, check GitHub status, and see AI insights.</p>
              </div>
            )}

          </div>
        </aside>
      </section>

      <InputModal
        open={Boolean(productionDeployTarget)}
        title="Deploy to production"
        label="Release tag"
        placeholder={defaultReleaseTag()}
        defaultValue={productionDeployTarget?.releaseTag ?? defaultReleaseTag()}
        confirmLabel={queueActionLoading === productionDeployTarget?.id ? "Deploying..." : "Start Deployment"}
        cancelLabel="Cancel"
        required
        onClose={() => {
          if (queueActionLoading) return;
          setProductionDeployTarget(null);
        }}
        onConfirm={(value) => {
          if (!productionDeployTarget || queueActionLoading) return;
          void startProductionDeploy(productionDeployTarget, value);
        }}
      />
      {releasePrTarget ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setReleasePrTarget(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <div className="eyebrow mono">Production promotion</div>
                <h2 style={{ margin: "4px 0 0" }}>
                  {releasePrTarget.releasePrNumber ? `Release PR #${releasePrTarget.releasePrNumber}` : "Create release PR"}
                </h2>
              </div>
              <button className="btn subtle compact" onClick={() => setReleasePrTarget(null)}>Close</button>
            </div>

            {releasePrTarget.releasePrNumber ? (
              <>
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  ShipBrain already found the release promotion for this develop preview. Do not create another release PR for the same develop snapshot.
                </p>
                <div className="card" style={{ padding: 12, margin: "12px 0" }}>
                  <p style={{ margin: 0, fontSize: 13 }}>
                    <strong>Status:</strong>{" "}
                    {releasePrTarget.releasePrStatus === "merged"
                      ? "Merged. Production deployment is waiting in the Production queue."
                      : "Open. Review and merge it before production deployment."}
                  </p>
                  {releasePrTarget.linkedReleaseStatus ? (
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                      Release state: {releasePrTarget.linkedReleaseStatus}
                    </p>
                  ) : null}
                </div>
                <div className="toolbar modal-actions" style={{ justifyContent: "space-between" }}>
                  <button className="btn subtle" onClick={() => setReleasePrTarget(null)}>Done</button>
                  {releasePrTarget.releasePrUrl ? (
                    <a className="btn-primary" href={releasePrTarget.releasePrUrl} target="_blank" rel="noreferrer">
                      <GitPullRequest size={12} />
                      Open Release PR
                    </a>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  Preview is live for develop, but ShipBrain has not found a develop-to-main release PR yet. Create one only when this preview is approved for production.
                </p>
                <div className="toolbar modal-actions" style={{ justifyContent: "space-between" }}>
                  <button className="btn subtle" onClick={() => setReleasePrTarget(null)}>Cancel</button>
                  <Link className="btn-primary" href="/spec-to-pr?template=develop-to-prod" onClick={() => setReleasePrTarget(null)}>
                    <Rocket size={12} />
                    Create Release PR
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
