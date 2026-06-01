"use client";

import { AlertTriangle, CheckCircle2, Clock, ExternalLink, GitBranch, GitMerge, GitPullRequest, Play, RefreshCw, Rocket, User, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { TraceActions } from "@/components/releases/TraceActions";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

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
  preview_deployment?: { url?: string; status?: string; runId?: string | number; run_id?: string | number; workflowRunId?: string | number } | null;
  production_deployment?: { url?: string; status?: string; tag?: string; releaseTag?: string; runId?: string | number; run_id?: string | number; workflowRunId?: string | number; isRollback?: boolean } | null;
  incident_id?: string | null;
  spec_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  is_rollback?: boolean;
  rollback_source_tag?: string | null;
  rollback_target_tag?: string | null;
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
    matches: (trace) => trace.status === "failed" || trace.pending_action?.type === "resolve_conflict",
    color: "#ba181b",
  },
  {
    id: "development",
    title: "Development",
    description: "Draft PRs, reviews, and develop merges.",
    empty: "No draft work in progress.",
    matches: (trace) =>
      !(trace.type === "hotfix" && trace.target_branch === "main") &&
      ["draft", "ready_for_review", "approved"].includes(trace.status),
    color: "#1e6091",
  },
  {
    id: "preview",
    title: "Preview",
    description: "Develop preview validation before promotion.",
    empty: "No preview validations.",
    matches: (trace) =>
      !(trace.type === "hotfix" && trace.target_branch === "main") &&
      ["merged_develop", "preview_live"].includes(trace.status),
    color: "#ffd000",
  },
  {
    id: "production",
    title: "Production",
    description: "Release PRs, tags, active deploys, and hotfixes.",
    empty: "No production deployments in flight.",
    matches: (trace) =>
      (trace.type === "hotfix" && trace.target_branch === "main" && ["draft", "ready_for_review", "approved", "merged_main", "production_live", "failed", "rolling_back"].includes(trace.status)) ||
      ["release_pending", "merged_main", "production_live", "completed", "rolling_back"].includes(trace.status),
    color: "#613dc1",
  },
  {
    id: "cancelled",
    title: "Closed",
    description: "Cancelled and rolled-back release traces kept for audit.",
    empty: "No closed traces.",
    matches: (trace) => ["cancelled", "rolled_back"].includes(trace.status),
    color: "#008000",
  },
];

function statusLabel(value: string) {
  return value.replace(/_/g, " ");
}

function stageClass(trace: Trace) {
  if (trace.status === "failed") return "failed";
  if (trace.status === "rolling_back") return "rolling_back";
  if (trace.status === "rolled_back") return "rolled_back";
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
  if (trace.status === "rolled_back" && trace.rollback_target_tag)
    return `This release was rolled back. Production is now on ${trace.rollback_target_tag}.`;
  if (trace.status === "rolling_back" && trace.rollback_target_tag)
    return `Rollback to ${trace.rollback_target_tag} is running.`;
  if (trace.preview_deployment?.url && trace.status === "preview_live")
    return "Preview is live. Promote to production when approved.";
  if (trace.production_deployment?.url)
    return "Production deployment is available.";
  if (trace.status === "completed") return "Production release is live and retained for audit.";
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

function eventTypeLabel(eventType: string): string {
  const labels: Record<string, string> = {
    trace_created: "Release trace created",
    pr_opened: "Pull request opened",
    pr_updated: "Pull request updated",
    review_requested: "Review requested",
    review_submitted: "Review submitted",
    pr_approved: "Pull request approved",
    pr_merged: "Pull request merged",
    deployment_started: "Production deployment started",
    deployment_succeeded: "Production deployment succeeded",
    deployment_failed: "Production deployment failed",
    preview_deploy_started: "Preview deployment started",
    preview_deployed: "Preview deployment completed",
    release_pr_created: "Release PR created",
    hotfix_created: "Hotfix branch created",
    reverse_sync_created: "Reverse sync PR created",
    reverse_sync_merged: "Reverse sync completed",
    incident_linked: "Incident linked to trace",
    manual_action: "Manual action taken",
    status_changed: "Status changed",
    rollback_initiated: "Rollback initiated",
    rollback_deployed: "Rollback completed",
    rollback_failed: "Rollback failed"
  };
  return labels[eventType] ?? eventType.replace(/_/g, " ");
}

function eventIcon(eventType: string) {
  if (eventType.includes("merged") || eventType === "pr_merged") return <GitMerge size={14} />;
  if (eventType.includes("pr_") || eventType.includes("review")) return <GitPullRequest size={14} />;
  if (eventType.includes("deploy") || eventType.includes("deployment")) return <Rocket size={14} />;
  if (eventType.includes("rollback")) return <RefreshCw size={14} />;
  if (eventType === "trace_created") return <Play size={14} />;
  if (eventType.includes("hotfix") || eventType.includes("branch")) return <GitBranch size={14} />;
  return <Clock size={14} />;
}

function eventStatusClass(eventType: string): string {
  if (eventType.includes("failed")) return "failed";
  if (eventType.includes("succeeded") || eventType.includes("completed") || eventType === "pr_merged" || eventType === "pr_approved" || eventType.includes("deployed")) return "success";
  if (eventType.includes("started") || eventType.includes("initiated")) return "running";
  return "";
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatActorName(actor?: string, source?: string): string {
  if (!actor) return source === "github" ? "GitHub" : source === "telegram" ? "Telegram Bot" : "System";
  if (actor === "github-actions" || actor === "github") return "GitHub Actions";
  if (actor === "ShipBrain sync") return "ShipBrain";
  if (actor.includes("@")) return actor.split("@")[0];
  return actor;
}

function journeyLabel(trace: Trace) {
  const feature = trace.draft_pr_number ? (trace.source_branch ?? "feature") : (trace.source_branch ?? "source");
  if (trace.type === "hotfix" && trace.target_branch === "main") {
    return trace.reverse_sync_pr_number
      ? `${feature} → main → production → sync develop`
      : `${feature} → main → production`;
  }
  if (trace.release_pr_number || ["release_pending", "merged_main", "production_live", "completed"].includes(trace.status)) {
    return `${feature} → develop → preview → main → production`;
  }
  if (trace.type === "hotfix") {
    return `${feature} → develop → preview`;
  }
  if (["merged_develop", "preview_live"].includes(trace.status)) {
    return `${feature} → develop → preview`;
  }
  return `${feature} → ${trace.target_branch ?? "target"}`;
}

function currentGateLabel(trace: Trace) {
  if (trace.type === "hotfix" && trace.target_branch === "main" && ["draft", "ready_for_review", "approved"].includes(trace.status)) {
    return "Production hotfix PR is awaiting incident fix approval.";
  }
  if (trace.status === "release_pending") return "Release PR merged. Waiting for Deploy to Production.";
  if (trace.status === "merged_main") return "Production deployment is running.";
  if (trace.status === "production_live") return "Production deployment completed.";
  if (trace.status === "completed") return "Production release completed.";
  if (trace.status === "rolling_back") return "Rollback is running.";
  if (trace.status === "rolled_back") return "Rollback completed.";
  if (trace.status === "preview_live") return "Preview is live. Ready for production promotion.";
  if (trace.status === "merged_develop") return "Develop merge detected. Waiting for preview deployment.";
  return trace.pending_action?.description ?? trace.current_phase ?? "Tracked";
}

export function ReleaseTraceBoard({ traces, eventsByTrace, userId }: { traces: Trace[]; eventsByTrace: Record<string, TraceEvent[]>; userId: string }) {
  const router = useRouter();
  const refreshTimer = useRef<number | null>(null);
  const [isPending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "live" | "syncing" | "offline">("connecting");
  const selected = useMemo(() => traces.find((trace) => trace.id === selectedId) ?? null, [selectedId, traces]);

  const refreshBoard = useCallback((source: "manual" | "webhook" = "manual") => {
    setLiveStatus(source === "webhook" ? "syncing" : "syncing");
    startTransition(() => {
      router.refresh();
      setLastSyncedAt(new Date());
      setLiveStatus("live");
    });
  }, [router]);

  const [isFixing, setIsFixing] = useState(false);
  const fixStaleTraces = useCallback(async () => {
    setIsFixing(true);
    try {
      const response = await fetch("/api/traces/fix-stale", { method: "POST" });
      const data = await response.json();
      if (data.fixed > 0) {
        refreshBoard("manual");
      }
    } catch {
      // Ignore errors
    }
    setIsFixing(false);
  }, [refreshBoard]);

  const scheduleWebhookRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshBoard("webhook");
    }, 450);
  }, [refreshBoard]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const handleRefetch = () => {
      refreshBoard("manual");
    };
    window.addEventListener("shipbrain-refetch", handleRefetch);
    return () => window.removeEventListener("shipbrain-refetch", handleRefetch);
  }, [refreshBoard]);

  useEffect(() => {
    if (selectedId && !traces.some((trace) => trace.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, traces]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`release-trace-board:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "release_traces",
          filter: `user_id=eq.${userId}`
        },
        scheduleWebhookRefresh
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "trace_events"
        },
        scheduleWebhookRefresh
      )
      .subscribe((status) => {
        setLiveStatus(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "offline" : "connecting");
      });

    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [scheduleWebhookRefresh, userId]);

  const grouped = columns.map((column) => ({
    ...column,
    traces: traces.filter(column.matches),
  }));

  return (
    <>
      <div className="release-board-toolbar">
        <div>
          <span className={`status-pill ${liveStatus === "live" ? "passed" : liveStatus === "offline" ? "failed" : "running"}`}>
            <span className="dot"></span>
            {liveStatus === "live" ? "Webhook live sync" : liveStatus === "offline" ? "Live sync offline" : "Syncing"}
          </span>
          <span className="release-sync-meta">
            {lastSyncedAt ? `Last synced ${lastSyncedAt.toLocaleTimeString()}` : "Listening for GitHub PR and workflow updates"}
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn subtle" type="button" onClick={fixStaleTraces} disabled={isFixing || isPending}>
            {isFixing ? "Fixing..." : "Fix Stale"}
          </button>
          <button className="btn subtle" type="button" onClick={() => refreshBoard("manual")} disabled={isPending || liveStatus === "syncing"}>
            <RefreshCw size={13} className={isPending || liveStatus === "syncing" ? "spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

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
                        <code>{journeyLabel(trace)}</code>
                      </div>
                      {(trace.status === "rolling_back" || trace.status === "rolled_back") && trace.rollback_target_tag ? (
                        <div className="rollback-indicator">
                          <RefreshCw size={11} className={trace.status === "rolling_back" ? "spin" : ""} />
                          <span>{trace.status === "rolling_back" ? "Rolling back to" : "Rolled back to"} {trace.rollback_target_tag}</span>
                        </div>
                      ) : null}
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
                  specId={selected.spec_id}
                  pendingType={selected.pending_action?.type ?? null}
                  status={selected.status}
                  repoFullName={selected.repo_full_name}
                  currentReleaseTag={selected.production_deployment?.releaseTag ?? selected.production_deployment?.tag}
                  type={selected.type}
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
                  <span>Journey</span><strong>{journeyLabel(selected)}</strong>
                  <span>Current gate</span><strong>{currentGateLabel(selected)}</strong>
                  <span>Feature PR</span><strong>{selected.draft_pr_number ? `#${selected.draft_pr_number}` : "n/a"}</strong>
                  <span>Release PR</span><strong>{selected.release_pr_number ? `#${selected.release_pr_number}` : "n/a"}</strong>
                  <span>Preview</span><strong>{selected.preview_deployment?.status ?? "n/a"} · {deploymentLabel(selected.preview_deployment?.url)}</strong>
                  <span>Production</span><strong>{selected.production_deployment?.status ?? "n/a"} · {deploymentLabel(selected.production_deployment?.url)}</strong>
                  <span>Release tag</span><strong>{selected.production_deployment?.releaseTag ?? selected.production_deployment?.tag ?? "n/a"}</strong>
                  {selected.is_rollback || selected.status === "rolling_back" || selected.status === "rolled_back" ? (
                    <>
                      <span>Rollback from</span><strong>{selected.rollback_source_tag ?? "n/a"}</strong>
                      <span>Rollback to</span><strong>{selected.rollback_target_tag ?? "n/a"}</strong>
                    </>
                  ) : null}
                  <span>Reverse sync</span><strong>{selected.reverse_sync_status ?? "n/a"}</strong>
                  <span>Incident</span><strong>{selected.incident_id ? shortId(selected.incident_id) : "n/a"}</strong>
                  <span>Updated</span><strong>{dateLabel(selected.updated_at)}</strong>
                </div>
              </section>

              {/* Audit Trail Section */}
              <section className="release-detail-section">
                <div className="section-label mono">
                  <span>Audit Trail</span>
                  <span className="count">{(eventsByTrace[selected.id] ?? []).length} events</span>
                </div>
                <div className="audit-trail-timeline">
                  {(eventsByTrace[selected.id] ?? []).length === 0 ? (
                    <div className="audit-trail-empty">No events recorded yet</div>
                  ) : (
                    (eventsByTrace[selected.id] ?? [])
                      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                      .map((event, idx) => (
                        <div key={event.id ?? idx} className={`audit-trail-item ${eventStatusClass(event.event_type)}`}>
                          <div className="audit-trail-icon">
                            {eventIcon(event.event_type)}
                          </div>
                          <div className="audit-trail-content">
                            <div className="audit-trail-header">
                              <span className="audit-trail-title">{eventTypeLabel(event.event_type)}</span>
                              <span className="audit-trail-time">{relativeTime(event.created_at)}</span>
                            </div>
                            <div className="audit-trail-meta">
                              <User size={12} />
                              <span>{formatActorName(event.actor, event.source)}</span>
                              {event.source ? (
                                <span className="audit-trail-source">via {event.source}</span>
                              ) : null}
                            </div>
                            {event.details && Object.keys(event.details).length > 0 ? (
                              <div className="audit-trail-details">
                                {event.details.prNumber ? <span>PR #{String(event.details.prNumber)}</span> : null}
                                {event.details.releaseTag ? <span>{String(event.details.releaseTag)}</span> : null}
                                {event.details.previewUrl ? <span className="audit-trail-url">Preview deployed</span> : null}
                                {event.details.workflowUrl ? (
                                  <a href={String(event.details.workflowUrl)} target="_blank" rel="noreferrer" className="audit-trail-link">
                                    View workflow <ExternalLink size={10} />
                                  </a>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </section>

            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
