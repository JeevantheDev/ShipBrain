import Link from "next/link";

type Trace = {
  id: string;
  title: string;
  type: string;
  repo_full_name: string;
  status: string;
  current_phase: string;
  source_branch: string;
  target_branch: string;
  pending_action?: { type?: string; description?: string } | null;
  draft_pr_number?: number | null;
  release_pr_number?: number | null;
  reverse_sync_pr_number?: number | null;
  reverse_sync_status?: string | null;
  preview_deployment?: { url?: string } | null;
  production_deployment?: { url?: string } | null;
};

export function TraceCard({ trace }: { trace: Trace }) {
  const steps = trace.type === "hotfix"
    ? ["hotfix PR", "production", "sync back", "done"]
    : trace.type === "release"
      ? ["release PR", "production", "verify", "done"]
      : ["draft PR", "preview", "release PR", "production"];
  const activeStep = trace.type === "hotfix"
    ? trace.reverse_sync_status === "merged"
      ? "done"
      : trace.reverse_sync_pr_number
        ? "sync back"
        : trace.production_deployment?.url
          ? "production"
          : "hotfix PR"
    : trace.current_phase === "development"
      ? steps[0]
      : trace.current_phase === "preview"
        ? steps[1]
        : trace.current_phase === "production"
          ? steps[2]
          : steps[3];

  return (
    <Link className="trace-card" href={`/releases/${trace.id}`}>
      <div className="trace-card-head">
        <div>
          <span className="eyebrow mono">{trace.type}</span>
          <h3>{trace.title}</h3>
        </div>
        <span className={`status-pill ${trace.status === "failed" ? "failed" : trace.pending_action ? "running" : "passed"}`}>
          {trace.status.replace(/_/g, " ")}
        </span>
      </div>
      <p className="muted">{trace.repo_full_name}</p>
      <div className="trace-branches">
        <code>{trace.source_branch}</code>
        <span>→</span>
        <code>{trace.target_branch}</code>
      </div>
      <div className="trace-steps" aria-label={`Current phase ${trace.current_phase}`}>
        {steps.map((step) => (
          <span className={step === activeStep ? "active" : ""} key={step}>{step}</span>
        ))}
      </div>
      {trace.pending_action ? (
        <p className="trace-action">{trace.pending_action.description}</p>
      ) : (
        <p className="trace-action muted">No pending action.</p>
      )}
    </Link>
  );
}
