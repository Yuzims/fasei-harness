import { checkMark } from "../lib/workbench";
import type { InvestigationResultViewModel } from "../lib/investigation-presentation";

export function FindingsPanel({
  view,
  onShowEvidence,
}: {
  view: InvestigationResultViewModel;
  onShowEvidence: (evidenceIds: string[]) => void;
}) {
  return (
    <section className="panel" data-testid="findings-panel">
      <h2 className="section-heading">🧭 调查发现</h2>
      <p className="panel-sub">以下发现由 Harness 根据调查步骤与已收集证据整理，不是 Agent 的判断。</p>
      {view.findings.length === 0 ? (
        <p className="empty">这次调查还没有可展示的调查发现。</p>
      ) : (
        <ul className="finding-list">
          {view.findings.map((finding) => (
            <li key={finding.id} className={finding.tone}>
              <span>{checkMark(finding.tone === "pass" ? "pass" : "warn")}</span>
              <span>{finding.text}</span>
              {finding.evidenceIds.length > 0 ? (
                <button
                  type="button"
                  className="chip"
                  data-testid={`finding-evidence-${finding.id}`}
                  onClick={() => onShowEvidence(finding.evidenceIds)}
                >
                  查看证据
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
