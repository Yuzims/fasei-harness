import type { InvestigationSessionDTO } from "@dto";
import { buildTraceItems } from "../lib/workbench";

export function TraceTimeline({ session }: { session: InvestigationSessionDTO }) {
  const items = buildTraceItems(session);

  return (
    <section className="panel">
      <h2>Investigation Trace</h2>
      {items.length === 0 ? (
        <p className="empty">No trace events in this session.</p>
      ) : (
        <ol className="trace">
          {items.map((item) => (
            <li key={item.id}>
              <span className={`trace-dot ${item.tone ?? ""}`} />
              <div>
                <div>{item.label}</div>
                {item.detail ? <div className="muted mono">{item.detail}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
