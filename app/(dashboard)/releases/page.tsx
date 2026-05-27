import { TraceCard } from "@/components/releases/TraceCard";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  const { data: traces } = user
    ? await supabase
        .from("release_traces")
        .select("*")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(40)
    : { data: [] };

  const pending = (traces ?? []).filter((trace) => trace.pending_action);
  const active = (traces ?? []).filter((trace) => !["completed", "cancelled"].includes(trace.status));
  const complete = (traces ?? []).filter((trace) => ["completed", "production_live"].includes(trace.status)).slice(0, 6);

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">Release Trace</span>
          <h1>One timeline for every PR, deploy, and hotfix.</h1>
          <p>Webhook-backed release state for Dashboard, CI Monitor, Incidents, and Telegram.</p>
        </div>
      </div>

      <section className="panel trace-section">
        <div className="panel-head">
          <div>
            <span className="eyebrow mono">Pending actions</span>
            <h2>{pending.length} release items need attention</h2>
          </div>
        </div>
        {pending.length ? (
          <div className="trace-grid">
            {pending.slice(0, 6).map((trace) => <TraceCard key={trace.id} trace={trace as any} />)}
          </div>
        ) : (
          <div className="empty-state compact">No pending release actions right now.</div>
        )}
      </section>

      <section className="panel trace-section">
        <div className="panel-head">
          <div>
            <span className="eyebrow mono">Active traces</span>
            <h2>Current release flow</h2>
          </div>
        </div>
        {active.length ? (
          <div className="trace-grid">
            {active.map((trace) => <TraceCard key={trace.id} trace={trace as any} />)}
          </div>
        ) : (
          <div className="empty-state compact">No active traces yet. Create a Draft PR or connect GitHub webhooks.</div>
        )}
      </section>

      {complete.length ? (
        <section className="panel trace-section">
          <div className="panel-head">
            <div>
              <span className="eyebrow mono">Recently live</span>
              <h2>Completed production movement</h2>
            </div>
          </div>
          <div className="trace-grid">
            {complete.map((trace) => <TraceCard key={trace.id} trace={trace as any} />)}
          </div>
        </section>
      ) : null}
    </>
  );
}
