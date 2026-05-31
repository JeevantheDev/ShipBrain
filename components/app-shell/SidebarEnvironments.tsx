"use client";

import { ChevronDown, ExternalLink, GitPullRequest, RefreshCw, Rocket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Environment = {
  id: string;
  repo: string;
  type: "preview" | "production";
  url?: string | null;
  status?: string | null;
  releaseTag?: string | null;
  updatedAt?: string | null;
};

type PendingDeploy = {
  id: string;
  queueType: "develop" | "production";
  stage: string;
  prNumber?: number | null;
  prUrl?: string | null;
  title: string;
  repo: string;
  branchName?: string | null;
  baseBranch?: string | null;
  releasePrNumber?: number | null;
  releasePrUrl?: string | null;
  previewUrl?: string | null;
  productionUrl?: string | null;
  updatedAt: string;
};

function shortRepo(value: string) {
  return value.split("/").pop() ?? value;
}

function statusLabel(env: Environment) {
  if (env.type === "production" && env.releaseTag) return env.releaseTag;
  return env.status?.replace(/_/g, " ") ?? "available";
}

function pendingStageLabel(item: PendingDeploy) {
  switch (item.stage) {
    case "hotfix_pr_open":
      return "hotfix PR open";
    case "awaiting_preview":
      return "preview pending";
    case "preview_deploying":
      return "preview deploying";
    case "preview_ready":
      return "preview ready";
    case "pending_production_deploy":
      return "prod deploy pending";
    case "deploying":
      return "prod deploying";
    case "deploy_failed":
      return "deploy failed";
    default:
      return item.stage.replace(/_/g, " ");
  }
}

function pendingHref(item: PendingDeploy) {
  return item.releasePrUrl ?? item.prUrl ?? item.previewUrl ?? item.productionUrl ?? "/ci";
}

function isOpenPendingPr(item: PendingDeploy) {
  return ["hotfix_pr_open", "release_pr_open", "draft_pr_open", "pr_open"].includes(item.stage);
}

export function SidebarEnvironments() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [pending, setPending] = useState<PendingDeploy[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState({ environments: false, pending: false });

  async function loadSidebarData() {
    try {
      const [envResponse, pendingResponse] = await Promise.all([
        fetch("/api/environments", { cache: "no-store" }),
        fetch("/api/deployments/pending", { cache: "no-store" })
      ]);
      if (envResponse.ok) setEnvironments(await envResponse.json());
      if (pendingResponse.ok) setPending(await pendingResponse.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSidebarData();
    const interval = window.setInterval(() => void loadSidebarData(), 60000);
    return () => window.clearInterval(interval);
  }, []);

  const visible = useMemo(
    () =>
      environments
        .filter((env) => env.url && env.url !== "#")
        .sort((a, b) => (a.type === b.type ? 0 : a.type === "production" ? -1 : 1))
        .slice(0, 2),
    [environments]
  );

  const visiblePending = useMemo(
    () =>
      pending
        .filter(isOpenPendingPr)
        .slice(0, 4),
    [pending]
  );

  if (!loading && visible.length === 0 && visiblePending.length === 0) return null;

  return (
    <div className="sidebar-env-block" aria-label="ShipBrain quick status">
      <div className="sidebar-env-head">
        <span>Quick status</span>
        <button type="button" aria-label="Refresh sidebar status" onClick={() => void loadSidebarData()}>
          <RefreshCw size={11} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="sidebar-accordion">
        {(loading || visible.length > 0) ? (
          <section className="sidebar-accordion-section">
            <button
              className="sidebar-accordion-trigger"
              type="button"
              aria-expanded={open.environments}
              onClick={() => setOpen((prev) => ({ ...prev, environments: !prev.environments }))}
            >
              <span>
                <Rocket size={12} />
                Env URLs
              </span>
              <span className="sidebar-accordion-meta">
                {loading ? "syncing" : visible.length}
                <ChevronDown size={13} className={open.environments ? "open" : ""} />
              </span>
            </button>
            {open.environments ? (
              loading ? (
                <div className="sidebar-env-empty">Syncing URLs...</div>
              ) : (
                <div className="sidebar-env-list">
                  {visible.map((env) => (
                    <a key={env.id} className="sidebar-env-link" href={env.url ?? "#"} target="_blank" rel="noreferrer">
                      <span className={`sidebar-env-dot ${env.type}`} aria-hidden="true" />
                      <span className="sidebar-env-copy">
                        <strong>{env.type === "production" ? "Production" : "Preview"}</strong>
                        <small>{shortRepo(env.repo)} · {statusLabel(env)}</small>
                      </span>
                      <ExternalLink size={12} />
                    </a>
                  ))}
                </div>
              )
            ) : null}
          </section>
        ) : null}

        {visiblePending.length > 0 ? (
          <section className="sidebar-accordion-section">
            <button
              className="sidebar-accordion-trigger"
              type="button"
              aria-expanded={open.pending}
              onClick={() => setOpen((prev) => ({ ...prev, pending: !prev.pending }))}
            >
              <span>
                <GitPullRequest size={12} />
                Pending PRs
              </span>
              <span className="sidebar-accordion-meta">
                {visiblePending.length}
                <ChevronDown size={13} className={open.pending ? "open" : ""} />
              </span>
            </button>
            {open.pending ? (
              <div className="sidebar-env-list sidebar-pending-list">
                {visiblePending.map((item) => (
                  <a key={`${item.id}-${item.stage}`} className="sidebar-env-link" href={pendingHref(item)} target={pendingHref(item).startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                    <span className={`sidebar-env-dot ${item.queueType}`} aria-hidden="true" />
                    <span className="sidebar-env-copy">
                      <strong>{item.prNumber ? `PR #${item.prNumber}` : item.queueType === "production" ? "Production" : "Preview"}</strong>
                      <small>{shortRepo(item.repo)} · {pendingStageLabel(item)}</small>
                    </span>
                    <ExternalLink size={12} />
                  </a>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
