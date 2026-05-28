import { ReleaseTraceBoard } from "@/components/releases/ReleaseTraceBoard";
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

  const traceIds = (traces ?? []).map((trace) => trace.id);
  const { data: events } = traceIds.length
    ? await supabase
        .from("trace_events")
        .select("*")
        .in("trace_id", traceIds)
        .order("created_at", { ascending: false })
    : { data: [] };

  const eventsByTrace = (events ?? []).reduce<Record<string, any[]>>((acc, event) => {
    if (!event.trace_id) return acc;
    acc[event.trace_id] = [...(acc[event.trace_id] ?? []), event];
    return acc;
  }, {});

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">Release Trace</span>
          <h1>One timeline for every PR, deploy, and hotfix.</h1>
          <p>Webhook-backed release state for Dashboard, CI Monitor, Incidents, and Telegram.</p>
        </div>
      </div>

      {traces?.length ? (
        <ReleaseTraceBoard traces={traces as any} eventsByTrace={eventsByTrace} />
      ) : (
        <section className="panel trace-section">
          <div className="empty-state compact">No release traces yet. Create a Draft PR or connect GitHub webhooks.</div>
        </section>
      )}
    </>
  );
}
