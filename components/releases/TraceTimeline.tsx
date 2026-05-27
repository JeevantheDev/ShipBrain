type TraceEvent = {
  id?: string;
  event_type: string;
  actor?: string;
  source?: string;
  created_at: string;
  details?: Record<string, unknown>;
};

export function TraceTimeline({ events }: { events: TraceEvent[] }) {
  if (!events.length) {
    return <p className="muted">No trace events captured yet.</p>;
  }

  return (
    <div className="trace-timeline">
      {events.map((event, index) => (
        <div className="trace-event" key={event.id ?? `${event.event_type}-${index}`}>
          <span className="trace-dot" />
          <div>
            <strong>{event.event_type.replace(/_/g, " ")}</strong>
            <p>
              {event.source ?? "system"} · {event.actor ?? "ShipBrain"} · {new Date(event.created_at).toLocaleString()}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
