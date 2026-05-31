"use client";

import Link from "next/link";
import { ArrowRight, Trash2, GitPullRequest } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CloseDraftPrModal } from "@/components/pr-sync/CloseDraftPrModal";

type RecentPrRun = {
  id: string;
  repo: string;
  branchName: string;
  baseBranch?: string;
  result: {
    prTitle: string;
    pr?: { number: number; html_url: string };
  };
  status: "pending_pr" | "draft_created" | "failed" | "rejected" | "closed" | "merged";
  ciStatus?: string;
  ciConclusion?: string | null;
  latestCiRunId?: string;
  deploymentStatus?: string;
  releaseTag?: string;
  releaseStatus?: string;
  deploymentUrl?: string;
  previewUrl?: string;
  previewStatus?: string;
  previewBranchAlias?: string;
  releasePrNumber?: number;
  releasePrUrl?: string;
  releasePrStatus?: string;
  mergeableState?: string;
  hasMergeConflicts?: boolean;
  updatedAt: string;
};

const storageKey = "shipbrain:recent-pr-runs";
const selectedStorageKey = "shipbrain:selected-pr-run";

export function DashboardPrOverview() {
  const [runs, setRuns] = useState<RecentPrRun[]>([]);
  const [setupWarning, setSetupWarning] = useState("");
  const [loading, setLoading] = useState(true);
  const [closeRun, setCloseRun] = useState<RecentPrRun | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState("");

  useEffect(() => {
    void loadRuns();
    const interval = window.setInterval(() => void loadRuns(), 30000);
    const handleRefetch = () => {
      void loadRuns();
    };
    window.addEventListener("shipbrain-refetch", handleRefetch);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("shipbrain-refetch", handleRefetch);
    };
  }, []);

  async function loadRuns() {
    try {
      const response = await fetch("/api/spec-runs", { cache: "no-store" });
      if (response.ok) {
        setRuns(mergeRuns((await response.json()) as RecentPrRun[]));
        setSetupWarning("");
        setLoading(false);
        return;
      }
      const json = await response.json().catch(() => ({}));
      if (json.detail) setSetupWarning(json.detail);
    } catch {
      // Fall back to localStorage while migrations/auth settle.
    }

    const saved = window.localStorage.getItem(storageKey);
    if (!saved) {
      setLoading(false);
      return;
    }
    try {
      setRuns(parseLocalRuns(saved));
    } catch {
      window.localStorage.removeItem(storageKey);
    } finally {
      setLoading(false);
    }
  }

  function parseLocalRuns(value: string) {
    try {
      return (JSON.parse(value) as RecentPrRun[]).slice(0, 5);
    } catch {
      return [];
    }
  }

  function mergeRuns(serverRuns: RecentPrRun[]) {
    if (serverRuns.length === 0) {
      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem(selectedStorageKey);
      return [];
    }

    const localRuns = parseLocalRuns(window.localStorage.getItem(storageKey) ?? "[]");
    const byId = new Map<string, RecentPrRun>();
    [...localRuns, ...serverRuns].forEach((run) => byId.set(run.id, run));
    const merged = Array.from(byId.values())
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5);
    window.localStorage.setItem(storageKey, JSON.stringify(merged));
    return merged;
  }

  async function deleteRun(id: string) {
    const run = runs.find((item) => item.id === id);
    if (run?.result.pr && run.status === "draft_created") {
      setCloseRun(run);
      setCloseError("");
      return;
    }

    const next = runs.filter((run) => run.id !== id);
    setRuns(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
    if (!id.startsWith("pr-run-")) {
      await fetch(`/api/spec-runs?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  async function closeDraftPrRun(input: { comment: string; deleteBranch: boolean }) {
    if (!closeRun) return;
    setCloseBusy(true);
    setCloseError("");
    try {
      const response = await fetch("/api/spec-runs/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: closeRun.id, comment: input.comment, deleteBranch: input.deleteBranch })
      });
      const json = await response.json();
      if (!response.ok) throw new Error([json.error, json.detail].filter(Boolean).join(" "));
      const next = runs.map((item) => item.id === closeRun.id ? { ...item, status: "closed" as RecentPrRun["status"], updatedAt: new Date().toISOString() } : item);
      setRuns(next);
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      setCloseRun(null);
    } catch (error) {
      setCloseError(error instanceof Error ? error.message : "Unable to close the Draft PR on GitHub.");
    } finally {
      setCloseBusy(false);
    }
  }

  const openPrs = useMemo(() => runs.filter((run) => run.status === "draft_created").length, [runs]);
  const pendingPrs = useMemo(() => runs.filter((run) => run.status === "pending_pr").length, [runs]);
  const activeCiRuns = useMemo(() => runs.filter((run) => run.ciStatus && run.ciStatus !== "completed").length, [runs]);
  const conflictedPrs = useMemo(() => runs.filter((run) => run.hasMergeConflicts).length, [runs]);
  const latestRelease = useMemo(() => runs.find((run) => run.releaseTag), [runs]);
  const activeRuns = useMemo(() => runs.filter((run) => {
    const activeRelease = run.releaseStatus === "release_pr_open" || run.releaseStatus === "pending_deploy" || run.releaseStatus === "deploying";
    return run.status !== "closed" && (run.status !== "merged" || activeRelease);
  }).slice(0, 5), [runs]);
  const syncedRuns = useMemo(() => runs.filter((run) => {
    const activeRelease = run.releaseStatus === "release_pr_open" || run.releaseStatus === "pending_deploy" || run.releaseStatus === "deploying";
    return run.status === "closed" || (run.status === "merged" && !activeRelease);
  }).slice(0, 1), [runs]);

  function statusLabel(run: RecentPrRun) {
    if (run.hasMergeConflicts) return "Merge conflicts";
    if (run.status === "draft_created") return `pr #${run.result.pr?.number ?? ""}`;
    if (run.status === "failed") return "Needs retry";
    if (run.status === "rejected") return "Rejected";
    if (run.status === "closed") return "Closed";
    if (run.status === "merged") return "Merged";
    return "Pending PR";
  }

  function ciLabel(run: RecentPrRun) {
    if (run.hasMergeConflicts) return "Resolve conflicts before approval";
    if (run.releasePrNumber && run.releaseStatus === "release_pr_open") return `Release PR #${run.releasePrNumber}`;
    if (run.releasePrNumber && run.releaseStatus === "pending_deploy") return `Pending prod deploy #${run.releasePrNumber}`;
    if (run.releaseTag && run.releaseStatus === "deploying") return `Release in progress ${run.releaseTag}`;
    if (run.releaseTag && run.releaseStatus === "deployed") return `Released ${run.releaseTag}`;
    if (run.releaseTag && run.releaseStatus === "failed") return `Release failed ${run.releaseTag}`;
    if (run.releaseTag) return `Release ${run.releaseTag}`;
    if (run.deploymentStatus === "approved") return "Deploy approved";
    if (run.deploymentStatus === "rejected") return "Deploy rejected";
    if (run.ciConclusion === "success") return "ci success";
    if (run.ciConclusion) return "ci failed";
    if (run.ciStatus) return `ci ${run.ciStatus}`;
    return "ci pending";
  }

  function canManageDraftRun(run: RecentPrRun) {
    return run.status === "pending_pr" || run.status === "draft_created";
  }

  return (
    <>
      {/* Metrics Row */}
      <section className="metrics">
        <div className="metric">
          <div className="metric-label">
            <span>Open PRs</span>
            <span className={`status-pill ${conflictedPrs ? "danger" : openPrs > 0 ? "passed" : ""}`}>
              <span className="dot"></span>
              {conflictedPrs ? "conflicted" : openPrs > 0 ? "draft" : "idle"}
            </span>
          </div>
          <div className="metric-row">
            <span className={`metric-num ${openPrs === 0 ? "zero" : ""}`}>{openPrs}</span>
          </div>
          <div className="metric-foot">
            <span className="metric-aside">
              {runs[0]?.result.pr?.number ? `latest pr #${runs[0].result.pr.number}` : "no active prs"}
            </span>
            <Link className="link-btn" href="/spec-to-pr">
              Spec-to-PR
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ marginLeft: 2 }}>
                <path d="M2 6h8M6 2l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Link>
          </div>
        </div>

        <div className="metric">
          <div className="metric-label">
            <span>Active AI Plans</span>
            <span className={`status-pill ${pendingPrs > 0 ? "passed" : ""}`}>
              <span className="dot"></span>
              {pendingPrs > 0 ? "running" : "idle"}
            </span>
          </div>
          <div className="metric-row">
            <span className={`metric-num ${pendingPrs === 0 ? "zero" : ""}`}>{pendingPrs}</span>
          </div>
          <div className="metric-foot">
            <span className="metric-aside">{pendingPrs > 0 ? `${pendingPrs} active run` : "no active runs"}</span>
          </div>
        </div>

        <div className="metric">
          <div className="metric-label">
            <span>Current Version</span>
            <span className="status-pill passed">
              <span className="dot"></span>stable
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-version">{latestRelease?.releaseTag ?? "v2026.05.25-beef63cb"}</span>
          </div>
          <div className="metric-foot">
            <span className="metric-aside tag">{runs[0]?.repo.split("/")[1] ?? "main"}</span>
            <div className="spark">
              <span style={{ height: 4 }}></span>
              <span style={{ height: 8 }}></span>
              <span style={{ height: 12 }}></span>
              <span className="hot" style={{ height: 15 }}></span>
            </div>
          </div>
        </div>
      </section>

      {/* Recent AI PRs Panel */}
      <div className="panel" style={{ marginTop: 24 }}>
        <header className="panel-head">
          <h2>
            Recent AI PRs
            <span className="badge-count">Latest {activeRuns.length}/5</span>
          </h2>
          <div className="tools">
            <Link href="/spec-to-pr" className="ghost-btn">
              Open Spec-to-PR
            </Link>
          </div>
        </header>

        {loading ? (
          <div className="loading-state" role="status" aria-live="polite" style={{ border: "none", background: "transparent" }}>
            <span className="loading-spinner" aria-hidden="true" />
            <strong>Loading recent AI PRs</strong>
            <p style={{ color: "var(--text-muted)", fontSize: "13px" }}>Checking workspace history...</p>
          </div>
        ) : activeRuns.length || syncedRuns.length ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {activeRuns.map((run) => {
              const isMerged = run.status === "merged";
              const isClosed = run.status === "closed";
              const canManageDraft = canManageDraftRun(run);
              return (
                <div className="pr-row" key={run.id}>
                  <div className={`pr-icon ${isMerged ? "merged" : ""}`} title={statusLabel(run)}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="3.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.2"/>
                      <circle cx="3.5" cy="10.5" r="1.6" stroke="currentColor" strokeWidth="1.2"/>
                      <circle cx="10.5" cy="10.5" r="1.6" stroke="currentColor" strokeWidth="1.2"/>
                      <path d="M3.5 5v4M5 10.5h4M8 3 10 5 8 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div>
                    <div className="pr-title">
                      <span className={`status-pill ${run.status === "draft_created" ? "passed" : ""}`}>
                        <span className="dot"></span>
                        {statusLabel(run)}
                      </span>
                      <span>{run.result.prTitle}</span>
                    </div>
                    <div className="pr-meta">
                      <span className="br">{run.repo}</span> · {run.branchName} · {run.baseBranch ?? "develop"}
                    </div>
                  </div>
                  <div className="pr-action">
                    {run.previewUrl ? (
                      <a className="btn subtle" href={run.previewUrl} target="_blank" rel="noreferrer">
                        Preview
                      </a>
                    ) : null}
                    {canManageDraft ? (
                      <Link
                        className="btn primary"
                        href="/spec-to-pr"
                        onClick={() => window.localStorage.setItem(selectedStorageKey, run.id)}
                      >
                        Resume
                      </Link>
                    ) : isMerged ? (
                      <Link className="btn subtle" href="/ci">
                        View in CI
                      </Link>
                    ) : (
                      <Link
                        className="btn subtle"
                        href="/spec-to-pr"
                        onClick={() => window.localStorage.setItem(selectedStorageKey, run.id)}
                      >
                        View record
                      </Link>
                    )}
                    {canManageDraft ? (
                      <button className="btn" style={{ padding: "0 8px", color: "var(--red)" }} aria-label="Delete recent PR" title="Delete" onClick={() => deleteRun(run.id)}>
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}

            {syncedRuns.map((run) => (
              <div className="pr-row" key={run.id}>
                <div className="pr-icon" style={{ color: "var(--text-muted)", background: "var(--panel-2)", borderColor: "var(--line-muted)" }}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                </div>
                <div>
                  <div className="pr-title" style={{ color: "var(--text-muted)" }}>
                    No drafts pending — last spec processed.
                  </div>
                  <div className="pr-meta">{run.branchName} · {statusLabel(run)}</div>
                </div>
                <div className="pr-action">
                  <Link
                    className="btn subtle"
                    href="/spec-to-pr"
                    onClick={() => window.localStorage.setItem(selectedStorageKey, run.id)}
                  >
                    View synced record
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {setupWarning ? (
              <div className="error-panel" role="alert" style={{ margin: "14px 18px" }}>
                <strong>Supabase setup needed</strong>
                <p>{setupWarning}</p>
              </div>
            ) : null}
            <div className="empty-state" style={{ border: "none", background: "transparent" }}>
              <strong>No AI PR plans yet</strong>
              <p style={{ color: "var(--text-muted)" }}>Generate a plan from Spec-to-PR and ShipBrain will keep the latest five here for quick resume.</p>
            </div>
          </>
        )}
      </div>

      <CloseDraftPrModal
        open={Boolean(closeRun)}
        prNumber={closeRun?.result.pr?.number}
        branchName={closeRun?.branchName ?? ""}
        title={closeRun?.result.prTitle ?? "Draft PR"}
        busy={closeBusy}
        error={closeError}
        onClose={() => {
          if (closeBusy) return;
          setCloseRun(null);
          setCloseError("");
        }}
        onConfirm={closeDraftPrRun}
      />
    </>
  );
}
