import { GitPullRequest, MessageSquare, Tag } from "lucide-react";

type TraceEvent = {
  id?: string;
  event_type: string;
  actor?: string;
  source?: string;
  created_at: string;
  details?: Record<string, any>;
};

export function TraceTimeline({ events }: { events: TraceEvent[] }) {
  if (!events.length) {
    return <p className="muted">No trace events captured yet.</p>;
  }

  return (
    <div className="trace-timeline">
      {events.map((event, index) => {
        const details = event.details ?? {};
        const note = details.note || details.notes;
        const releaseTag = details.releaseTag || details.tag;
        const prNumber = details.prNumber || details.pr?.number;

        return (
          <div className="trace-event" key={event.id ?? `${event.event_type}-${index}`}>
            <span className="trace-dot" />
            <div style={{ flex: 1 }}>
              <strong>{event.event_type.replace(/_/g, " ")}</strong>
              <p style={{ margin: "2px 0 0", color: "var(--text-muted)", fontSize: "12px" }}>
                {event.source ?? "system"} · {event.actor ?? "ShipBrain"} · {new Date(event.created_at).toLocaleString()}
              </p>
              {(note || releaseTag || prNumber) && (
                <div style={{
                  marginTop: 8,
                  padding: 10,
                  background: "var(--panel-2)",
                  border: "1px solid var(--line-muted)",
                  borderRadius: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  fontSize: "12.5px"
                }}>
                  {note && (
                    <div style={{ display: "flex", gap: 6, alignItems: "flex-start", color: "var(--text-muted)" }}>
                      <MessageSquare size={13} style={{ flexShrink: 0, marginTop: 3 }} />
                      <span style={{ fontStyle: "italic" }}>&ldquo;{note}&rdquo;</span>
                    </div>
                  )}
                  {releaseTag && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <Tag size={13} style={{ flexShrink: 0, color: "var(--brand)" }} />
                      <span>Release Tag: <code style={{ fontSize: "11.5px", background: "var(--panel-3)", padding: "1px 4px", borderRadius: 4 }}>{releaseTag}</code></span>
                    </div>
                  )}
                  {prNumber && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <GitPullRequest size={13} style={{ flexShrink: 0, color: "var(--brand)" }} />
                      <span>PR: <code>#{prNumber}</code></span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
