"use client";

import Link from "next/link";
import { ArrowRight, GitPullRequest, Trash2 } from "lucide-react";
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
    return () => window.clearInterval(interval);
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
    if (run.status === "draft_created") return `PR #${run.result.pr?.number ?? ""}`;
    if (run.status === "failed") return "Needs retry";
    if (run.status === "rejected") return "Rejected";
    if (run.status === "closed") return "Closed on GitHub";
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
    if (run.ciConclusion === "success") return "CI passed";
    if (run.ciConclusion) return "CI failed";
    if (run.ciStatus) return `CI ${run.ciStatus}`;
    return "CI pending";
  }

  return (
    <>
      <section className="grid three">
        <article className="card metric">
          <div>
            <p>Open PRs</p>
            <strong>{openPrs}</strong>
          </div>
          <span className={`status ${conflictedPrs ? "red" : "green"}`}>{conflictedPrs ? `${conflictedPrs} conflicted` : "Draft"}</span>
        </article>
        <article className="card metric">
          <div>
            <p>Pending AI Plans</p>
            <strong>{pendingPrs}</strong>
          </div>
          <span className="status amber">Resume</span>
        </article>
        <article className="card metric">
          <div>
            <p>Current Version</p>
            <strong style={{ fontSize: latestRelease?.releaseTag ? 18 : 34 }}>{latestRelease?.releaseTag ?? "None"}</strong>
          </div>
          <span className="status amber">{activeCiRuns ? `${activeCiRuns} CI active` : "Release"}</span>
        </article>
      </section>

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ marginBottom: 0 }}>Recent AI PRs</h2>
          <Link className="button secondary compact" href="/spec-to-pr">
            Open Spec-to-PR
            <ArrowRight size={14} />
          </Link>
        </div>
        {loading ? (
          <div className="loading-state" role="status" aria-live="polite">
            <span className="loading-spinner" aria-hidden="true" />
            <strong>Loading recent AI PRs</strong>
            <p>Checking your workspace history and syncing the latest saved runs.</p>
          </div>
        ) : activeRuns.length || syncedRuns.length ? (
          <>
            {activeRuns.length ? (
              <div className="recent-pr-list dashboard">
                {activeRuns.map((run) => (
                  <div className="recent-pr-row" key={run.id}>
                    <Link
                      className="recent-pr-item"
                      href="/spec-to-pr"
                      onClick={() => window.localStorage.setItem(selectedStorageKey, run.id)}
                    >
                      <GitPullRequest size={16} />
                      <span>{run.result.prTitle}</span>
                      <small>{run.branchName} → {run.baseBranch ?? "develop"}</small>
                      <em>{statusLabel(run)}</em>
                      <small>{ciLabel(run)}</small>
                      {run.previewUrl ? <small>Vercel Preview ready</small> : run.previewStatus === "failed" ? <small>Preview failed</small> : null}
                    </Link>
                    {run.previewUrl ? (
                      <a className="button secondary compact" href={run.previewUrl} target="_blank" rel="noreferrer">
                        Preview
                      </a>
                    ) : null}
                    <button className="icon-button danger-icon" aria-label="Delete recent PR" title="Delete" onClick={() => deleteRun(run.id)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {syncedRuns.map((run) => (
              <Link
                className="recent-pr-closed-link"
                href="/spec-to-pr"
                key={run.id}
                onClick={() => window.localStorage.setItem(selectedStorageKey, run.id)}
              >
                <span>{statusLabel(run)} · {run.branchName}</span>
                <strong>View synced record</strong>
              </Link>
            ))}
          </>
        ) : (
          <>
            {setupWarning ? (
              <div className="error-panel" role="alert" style={{ marginBottom: 12 }}>
                <strong>Supabase setup needed</strong>
                <p>{setupWarning}</p>
              </div>
            ) : null}
            <div className="empty-state">
              <strong>No AI PR plans yet</strong>
              <p>Generate a plan from Spec-to-PR and ShipBrain will keep the latest five here for quick resume.</p>
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
