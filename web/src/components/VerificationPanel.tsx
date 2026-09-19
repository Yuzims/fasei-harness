import type { InvestigationSessionDTO } from "@dto";
import { buildInvestigationResultView } from "../lib/investigation-presentation";
import { verificationTone } from "../lib/workbench";

export function VerificationSummary({ session }: { session: InvestigationSessionDTO }) {
  const { result } = buildInvestigationResultView(session);

  return (
    <section className={`banner ${result.tone}`} data-testid="result-banner">
      <p className="kicker">调查结果</p>
      <h2 className="banner-title">{result.statusLabel}</h2>
      <p className="banner-copy">{result.subtitle}</p>
      <p className="muted">{result.issueLine}</p>
    </section>
  );
}

export function VerificationChecks({ session }: { session: InvestigationSessionDTO }) {
  const { harness } = buildInvestigationResultView(session);

  return (
    <section className="panel lane lane-harness" data-testid="harness-panel">
      <h2 className="section-heading">🔍 Harness 独立验证</h2>
      <p className="panel-sub">{harness.disclaimer}</p>
      <p className={`status-text ${verificationTone(session.verification?.status)}`}>{harness.statusLabel}</p>
      <p className="kicker" style={{ marginTop: 12 }}>
        证据检查
      </p>
      {harness.checks.length === 0 ? (
        <p className="empty">这次调查没有验证检查。</p>
      ) : (
        harness.checks.map((check) => (
          <div key={check.id} className={`check ${check.tone}`}>
            <span>{check.label}</span>
            <span>{check.mark}</span>
          </div>
        ))
      )}
      {harness.satisfiedLabel ? (
        <p className="coverage" data-testid="requirement-summary">
          {harness.satisfiedLabel}
        </p>
      ) : null}
    </section>
  );
}
