import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TraceActions } from "@/components/releases/TraceActions";
import { TraceTimeline } from "@/components/releases/TraceTimeline";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const supabase = getSupabaseServerClient();
  const { data: trace } = await supabase
    .from("release_traces")
    .select("title, type")
    .eq("id", params.id)
    .maybeSingle();

  if (!trace) {
    return {
      title: "Release Trace Detail | ShipBrain"
    };
  }

  return {
    title: `${trace.title} (${trace.type}) | ShipBrain`,
    description: `Track details and events timeline for release trace: ${trace.title}.`
  };
}

export const dynamic = "force-dynamic";

export default async function ReleaseTraceDetailPage({ params }: { params: { id: string } }) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: trace } = await supabase
    .from("release_traces")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!trace) notFound();

  const { data: events } = await supabase
    .from("trace_events")
    .select("*")
    .eq("trace_id", trace.id)
    .order("created_at", { ascending: false });

  const action = trace.pending_action as { type?: string; description?: string } | null;

  return (
    <>
      <div className="page-header">
        <div>
          <Link className="subtle-link" href="/releases">← Back to release trace</Link>
          <span className="eyebrow">{trace.type}</span>
          <h1>{trace.title}</h1>
          <p>{trace.source_branch} → {trace.target_branch} · {trace.repo_full_name}</p>
        </div>
        <span className={`status-pill ${trace.status === "failed" ? "failed" : action ? "running" : "passed"}`}>
          {trace.status.replace(/_/g, " ")}
        </span>
      </div>

      {action ? (
        <section className="panel trace-section attention">
          <span className="eyebrow mono">Pending action</span>
          <h2>{action.type?.replace(/_/g, " ")}</h2>
          <p>{action.description}</p>
          <TraceActions
            traceId={trace.id}
            pendingType={action.type ?? null}
            status={trace.status}
            type={trace.type}
            repoFullName={trace.repo_full_name}
            currentReleaseTag={trace.production_deployment?.releaseTag ?? trace.production_deployment?.tag}
          />
        </section>
      ) : null}

      <section className="grid two">
        <div className="panel trace-section">
          <span className="eyebrow mono">Details</span>
          <div className="trace-detail-list">
            <span>{trace.type === "hotfix" ? "Hotfix PR" : "Draft PR"}</span><strong>{trace.draft_pr_number ? `#${trace.draft_pr_number}` : "n/a"}</strong>
            <span>{trace.type === "hotfix" ? "Sync PR" : "Release PR"}</span><strong>{trace.type === "hotfix" ? (trace.reverse_sync_pr_number ? `#${trace.reverse_sync_pr_number}` : "n/a") : (trace.release_pr_number ? `#${trace.release_pr_number}` : "n/a")}</strong>
            <span>Phase</span><strong>{trace.current_phase}</strong>
            <span>Incident</span><strong>{trace.incident_id ? trace.incident_id.slice(0, 8) : "n/a"}</strong>
          </div>
        </div>
        <div className="panel trace-section">
          <span className="eyebrow mono">Deployments</span>
          <div className="trace-detail-list">
            <span>Preview</span><strong>{trace.preview_deployment?.status ?? "n/a"}</strong>
            <span>Production</span><strong>{trace.production_deployment?.status ?? "n/a"}</strong>
            <span>Reverse sync</span><strong>{trace.reverse_sync_status ?? "n/a"}</strong>
          </div>
        </div>
      </section>

      {!action ? (
        <section className="panel trace-section">
          <span className="eyebrow mono">Manual controls</span>
          <TraceActions
            traceId={trace.id}
            status={trace.status}
            type={trace.type}
            repoFullName={trace.repo_full_name}
            currentReleaseTag={trace.production_deployment?.releaseTag ?? trace.production_deployment?.tag}
          />
        </section>
      ) : null}

      <section className="panel trace-section">
        <span className="eyebrow mono">Timeline</span>
        <TraceTimeline events={(events ?? []) as any} />
      </section>
    </>
  );
}
