"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Rocket,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { TraceActions } from "@/components/releases/TraceActions";
import { TraceTimeline } from "@/components/releases/TraceTimeline";

type TraceEvent = {
  id?: string;
  trace_id?: string;
  event_type: string;
  actor?: string;
  source?: string;
  created_at: string;
  details?: Record<string, unknown>;
};

type PendingAction = {
  type?: string;
  description?: string;
  actor?: string;
};

type Trace = {
  id: string;
  title: string;
  type: string;
  repo_full_name: string;
  status: string;
  current_phase?: string | null;
  source_branch?: string | null;
  target_branch?: string | null;
  pending_action?: PendingAction | null;
  draft_pr_number?: number | null;
  draft_pr_url?: string | null;
  release_pr_number?: number | null;
  release_pr_url?: string | null;
  reverse_sync_pr_number?: number | null;
  reverse_sync_pr_url?: string | null;
  reverse_sync_status?: string | null;
  preview_deployment?: {
    url?: string;
    status?: string;
    runId?: string | number;
    run_id?: string | number;
    workflowRunId?: string | number;
  } | null;
  production_deployment?: {
    url?: string;
    status?: string;
    tag?: string;
    releaseTag?: string;
    runId?: string | number;
    run_id?: string | number;
    workflowRunId?: string | number;
  } | null;
  incident_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type BoardColumn = {
  id: string;
  title: string;
  description: string;
  empty: string;
  matches: (trace: Trace) => boolean;
  color: string;
};

const columns: BoardColumn[] = [
  {
    id: "attention",
    title: "Needs attention",
    description: "Blocked, failed, or waiting on a human decision.",
    empty: "No blocked releases.",
    matches: (trace) =>
      trace.status === "failed" || Boolean(trace.pending_action),
    color: "#ba181b",
  },
  {
    id: "development",
    title: "Development",
    description: "Draft PRs, reviews, and develop merges.",
    empty: "No draft work in progress.",
    matches: (trace) =>
      !trace.pending_action &&
      ["draft", "ready_for_review", "approved"].includes(trace.status),
    color: "#1e6091",
  },
  {
    id: "preview",
    title: "Preview",
    description: "Develop preview validation before promotion.",
    empty: "No preview validations.",
    matches: (trace) =>
      !trace.pending_action &&
      ["merged_develop", "preview_live"].includes(trace.status),
    color: "#ffd000",
  },
  {
    id: "production",
    title: "Production",
    description: "Release PRs, tags, deploys, and hotfixes.",
    empty: "No production deployments in flight.",
    matches: (trace) =>
      !trace.pending_action &&
      ["release_pending", "merged_main", "production_live"].includes(
        trace.status,
      ),
    color: "#613dc1",
  },
  {
    id: "done",
    title: "Done",
    description: "Completed or cancelled release traces.",
    empty: "No completed traces yet.",
    matches: (trace) => ["completed", "cancelled"].includes(trace.status),
    color: "#008000",
  },
];

function statusLabel(value: string) {
  return value.replace(/_/g, " ");
}

function stageClass(trace: Trace) {
  if (trace.status === "failed") return "failed";
  if (trace.pending_action) return "running";
  if (["completed", "production_live"].includes(trace.status)) return "passed";
  return "";
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function dateLabel(value?: string | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

function primaryActionLabel(trace: Trace) {
  if (trace.pending_action?.description)
    return trace.pending_action.description;
  if (trace.preview_deployment?.url && trace.status === "preview_live")
    return "Preview is live. Promote to production when approved.";
  if (trace.production_deployment?.url)
    return "Production deployment is available.";
  if (trace.status === "completed") return "Release trace completed.";
  return "No pending action.";
}

function traceHref(trace: Trace, kind: "draft" | "release" | "sync") {
  if (kind === "draft") return trace.draft_pr_url;
  if (kind === "release") return trace.release_pr_url;
  return trace.reverse_sync_pr_url;
}

function workflowRunIdFromUrl(url?: string | null) {
  if (!url) return null;
  const match = url.match(/\/actions\/runs\/(\d+)/);
  return match?.[1] ?? null;
}

function deploymentRunId(
  deployment?: Trace["preview_deployment"] | Trace["production_deployment"],
) {
  const direct =
    deployment?.runId ?? deployment?.run_id ?? deployment?.workflowRunId;
  return direct ? String(direct) : workflowRunIdFromUrl(deployment?.url);
}

function ciMonitorHref(trace: Trace) {
  const runId =
    deploymentRunId(trace.production_deployment) ??
    deploymentRunId(trace.preview_deployment);
  return runId ? `/ci?run=${encodeURIComponent(runId)}` : "/ci";
}

function deploymentLabel(url?: string) {
  if (!url) return "Not available yet";
  return url.includes("/actions/runs/")
    ? "GitHub Actions workflow"
    : "Deployment URL";
}

export function ReleaseTraceBoard({
  traces,
  eventsByTrace,
}: {
  traces: Trace[];
  eventsByTrace: Record<string, TraceEvent[]>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => traces.find((trace) => trace.id === selectedId) ?? null,
    [selectedId, traces],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const grouped = columns.map((column) => ({
    ...column,
    traces: traces.filter(column.matches),
  }));

  return (
    <>
      <section className="release-board-shell">
        <div className="release-board">
          {grouped.map((column) => (
            <div className="release-board-column" key={column.id} style={{borderTop:`4px solid ${column.color}`}}>
              <div className="release-column-head">
                <div>
                  <h2>{column.title}</h2>
                  <p>{column.description}</p>
                </div>
                <span className="badge-count">{column.traces.length}</span>
              </div>

              <div className="release-column-list">
                {column.traces.length ? (
                  column.traces.map((trace) => (
                    <button
                      className={`release-board-card ${selectedId === trace.id ? "active" : ""}`}
                      key={trace.id}
                      type="button"
                      onClick={() => setSelectedId(trace.id)}
                    >
                      <div className="release-card-top">
                        <span className={`trace-type-pill ${trace.type}`}>
                          {trace.type}
                        </span>
                        <span className={`status-pill ${stageClass(trace)}`}>
                          <span className="dot"></span>
                          {statusLabel(trace.status)}
                        </span>
                      </div>
                      <strong>{trace.title}</strong>
                      <p>{trace.repo_full_name}</p>
                      <div className="trace-branches">
                        <code>{trace.source_branch ?? "source"}</code>
                        <span>→</span>
                        <code>{trace.target_branch ?? "target"}</code>
                      </div>
                      <div className="release-card-footer">
                        {trace.pending_action ? (
                          <AlertTriangle size={13} />
                        ) : (
                          <CheckCircle2 size={13} />
                        )}
                        <span>
                          {trace.pending_action?.type
                            ? statusLabel(trace.pending_action.type)
                            : (trace.current_phase ?? "tracked")}
                        </span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="release-column-empty">{column.empty}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {selected ? (
        <div
          className="release-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelectedId(null)}
        >
          <aside
            className="release-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="release-drawer-head">
              <div>
                <span className="eyebrow mono">
                  {selected.type} · {shortId(selected.id)}
                </span>
                <h2>{selected.title}</h2>
                <p>{selected.repo_full_name}</p>
              </div>
              <button
                className="icon-btn"
                type="button"
                aria-label="Close release details"
                onClick={() => setSelectedId(null)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="release-drawer-scroll">
              <section
                className={`release-detail-callout ${selected.pending_action ? "attention" : ""}`}
              >
                <div>
                  <span className={`status-pill ${stageClass(selected)}`}>
                    <span className="dot"></span>
                    {statusLabel(selected.status)}
                  </span>
                  <h3>
                    {selected.pending_action?.type
                      ? statusLabel(selected.pending_action.type)
                      : (selected.current_phase ?? "Release trace")}
                  </h3>
                  <p>{primaryActionLabel(selected)}</p>
                </div>
                <TraceActions
                  traceId={selected.id}
                  pendingType={selected.pending_action?.type ?? null}
                  status={selected.status}
                />
              </section>

              <section className="release-detail-section">
                <div className="section-label mono">
                  <span>Workflow references</span>
                  <span className="count">links</span>
                </div>
                <div className="release-link-grid">
                  {selected.draft_pr_number ? (
                    <a
                      className="btn subtle"
                      href={traceHref(selected, "draft") ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <GitPullRequest size={13} />
                      Draft PR #{selected.draft_pr_number}
                      <ExternalLink size={12} />
                    </a>
                  ) : null}
                  {selected.release_pr_number ? (
                    <a
                      className="btn subtle"
                      href={traceHref(selected, "release") ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <GitPullRequest size={13} />
                      Release PR #{selected.release_pr_number}
                      <ExternalLink size={12} />
                    </a>
                  ) : null}
                  {selected.reverse_sync_pr_number ? (
                    <a
                      className="btn subtle"
                      href={traceHref(selected, "sync") ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <GitPullRequest size={13} />
                      Sync PR #{selected.reverse_sync_pr_number}
                      <ExternalLink size={12} />
                    </a>
                  ) : null}
                  {selected.preview_deployment?.url ? (
                    <a
                      className="btn subtle"
                      href={selected.preview_deployment.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Rocket size={13} />
                      Open preview URL
                      <ExternalLink size={12} />
                    </a>
                  ) : null}
                  {selected.production_deployment?.url ? (
                    <a
                      className="btn subtle"
                      href={selected.production_deployment.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Rocket size={13} />
                      Open production URL
                      <ExternalLink size={12} />
                    </a>
                  ) : null}
                  <Link className="btn subtle" href={ciMonitorHref(selected)}>
                    View in CI Monitor
                  </Link>
                </div>
              </section>

              <section className="release-detail-section">
                <div className="section-label mono">
                  <span>Details</span>
                  <span className="count">state</span>
                </div>
                <div className="trace-detail-list">
                  <span>Branches</span>
                  <strong>
                    {selected.source_branch ?? "n/a"} →{" "}
                    {selected.target_branch ?? "n/a"}
                  </strong>
                  <span>Preview</span>
                  <strong>
                    {selected.preview_deployment?.status ?? "n/a"} ·{" "}
                    {deploymentLabel(selected.preview_deployment?.url)}
                  </strong>
                  <span>Production</span>
                  <strong>
                    {selected.production_deployment?.status ?? "n/a"} ·{" "}
                    {deploymentLabel(selected.production_deployment?.url)}
                  </strong>
                  <span>Release tag</span>
                  <strong>
                    {selected.production_deployment?.releaseTag ??
                      selected.production_deployment?.tag ??
                      "n/a"}
                  </strong>
                  <span>Reverse sync</span>
                  <strong>{selected.reverse_sync_status ?? "n/a"}</strong>
                  <span>Incident</span>
                  <strong>
                    {selected.incident_id
                      ? shortId(selected.incident_id)
                      : "n/a"}
                  </strong>
                  <span>Updated</span>
                  <strong>{dateLabel(selected.updated_at)}</strong>
                </div>
              </section>

              <section className="release-detail-section">
                <div className="section-label mono">
                  <span>Timeline</span>
                  <span className="count">
                    {eventsByTrace[selected.id]?.length ?? 0}
                  </span>
                </div>
                <TraceTimeline events={eventsByTrace[selected.id] ?? []} />
              </section>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
