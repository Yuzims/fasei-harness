import { checkMark } from "../lib/workbench";
import type { LiveProcessItem } from "../lib/investigation-stream";
import type { InvestigationResultViewModel } from "../lib/investigation-presentation";

function liveMarker(state: LiveProcessItem["state"]): string {
  if (state === "active") {
    return "⟳";
  }
  return checkMark(state === "pass" ? "pass" : state === "fail" ? "fail" : "warn");
}

export function InvestigationProcessPanel({
  view,
  live,
}: {
  view?: InvestigationResultViewModel;
  live?: { items: LiveProcessItem[]; running: boolean };
}) {
  if (live) {
    return (
      <section className="panel" data-testid="process-panel" aria-live="polite">
        <h2 className="section-heading">🔎 调查过程</h2>
        {live.running ? <p className="muted">Agent 正在调查……</p> : null}
        {live.items.length === 0 ? (
          <p className="empty">正在启动调查……</p>
        ) : (
          <ol className="step-list">
            {live.items.map((item) => (
              <li key={item.id} className={item.state === "fail" ? "fail" : item.state === "active" ? "pending" : "pass"}>
                <span>{liveMarker(item.state)}</span>
                <span>{item.label}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  }

  const process = view?.process;

  return (
    <section className="panel" data-testid="process-panel">
      <h2 className="section-heading">🔎 调查过程</h2>
      {!process || process.emptyMessage ? (
        <p className="empty">{process?.emptyMessage ?? "暂无调查过程。"}</p>
      ) : (
        <ol className="step-list">
          {process.steps.map((step) => (
            <li key={step.id} className={step.success ? "pass" : "fail"}>
              <span>{checkMark(step.success ? "pass" : "fail")}</span>
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
