import { formatMetric, requirementLabel } from "../lib/workbench";
import type { InvestigationResultViewModel } from "../lib/investigation-presentation";

export function InvestigationResultBanner({ view }: { view: InvestigationResultViewModel }) {
  return (
    <section className={`banner ${view.tone}`} data-testid="result-banner">
      <p className="kicker">调查结果</p>
      <h2 className="banner-title">{view.statusLabel}</h2>
      <p className="banner-copy">{view.summary}</p>
      <p className="muted">{view.issueLine}</p>
    </section>
  );
}

export function IndependentVerificationPanel({ view }: { view: InvestigationResultViewModel }) {
  const verification = view.verification;
  const coverage =
    typeof verification.evidenceCoverage === "number" && Number.isFinite(verification.evidenceCoverage)
      ? formatMetric("evidenceCoverage", verification.evidenceCoverage)
      : undefined;

  return (
    <section className="panel lane lane-harness" data-testid="verification-panel">
      <h2 className="section-heading">🔍 独立验证</h2>
      <p className="panel-sub">
        以下判断由 Harness 根据收集到的证据独立完成，不采用 Agent 的最终结论作为验证依据。
      </p>
      <p className={`status-text ${view.tone}`}>{view.statusLabel}</p>
      <p className="kicker" style={{ marginTop: 12 }}>
        证据检查
      </p>
      {verification.checks.length === 0 ? (
        <p className="empty">这次调查没有验证检查。</p>
      ) : (
        verification.checks.map((check) => (
          <div key={check.id} className={`check ${check.tone}`}>
            <span>{check.label}</span>
            <span>{check.mark}</span>
          </div>
        ))
      )}
      {verification.satisfiedLabel ? (
        <p className="coverage" data-testid="requirement-summary">
          {verification.satisfiedLabel}
        </p>
      ) : null}
      {coverage ? <p className="muted">证据覆盖率：{coverage}</p> : null}
      {verification.missingRequirementIds.length > 0 ? (
        <div className="lane-block">
          <p className="kicker">尚未满足的证据要求</p>
          <ul className="empty-list">
            {verification.missingRequirementIds.map((id) => (
              <li key={id}>{requirementLabel(id)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className={verification.unsupportedClaimIds.length > 0 ? "compare-note" : "muted"} data-testid="unsupported-claims">
        {verification.unsupportedClaimIds.length > 0
          ? `存在 ${verification.unsupportedClaimIds.length} 条未被证据支持的结论：${verification.unsupportedClaimIds.join("、")}`
          : "未发现未被证据支持的结论。"}
      </p>
      {verification.prematureCompletion ? (
        <p className="check fail" data-testid="premature-completion">
          Agent 在证据仍不完整时结束了调查。
        </p>
      ) : null}
    </section>
  );
}
