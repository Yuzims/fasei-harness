import type { InvestigationSessionDTO } from "@dto";
import {
  agentConclusion,
  agentHarnessDisagree,
  checkLabel,
  checkMark,
  checkTone,
  evidenceCoverageLabel,
  issueRef,
  issueStateLabel,
  primaryVerificationChecks,
  verificationLabel,
  verificationSubtitle,
  verificationTone,
} from "../lib/workbench";

export function VerificationSummary({ session }: { session: InvestigationSessionDTO }) {
  const status = session.verification?.status;
  const tone = verificationTone(status);
  const issueTitle = session.issue.title || session.issue.summary;

  return (
    <section className={`banner ${tone}`} data-testid="result-banner">
      <p className="kicker">调查结果</p>
      <h2 className="banner-title">{verificationLabel(status)}</h2>
      <p className="banner-copy">{verificationSubtitle(status)}</p>
      <p className="muted">
        {issueRef(session.task)}
        {issueTitle ? ` · ${issueTitle}` : ""}
        {session.issue.state ? ` · ${issueStateLabel(session.issue.state)}` : ""}
      </p>
    </section>
  );
}

export function AgentHarnessCompare({ session }: { session: InvestigationSessionDTO }) {
  if (!agentHarnessDisagree(session)) {
    return null;
  }

  return (
    <section className="compare" data-testid="agent-harness-compare">
      <div>
        <p className="kicker">Agent 结论</p>
        <p>{agentConclusion(session)}</p>
      </div>
      <div>
        <p className="kicker">Harness 验证</p>
        <p>{verificationSubtitle(session.verification?.status)}</p>
      </div>
      <p className="compare-note">Agent 的判断仅作为调查结果，不作为最终事实。</p>
    </section>
  );
}

export function VerificationChecks({ session }: { session: InvestigationSessionDTO }) {
  const checks = primaryVerificationChecks(session);
  const coverage = evidenceCoverageLabel(session);

  return (
    <section className="panel lane lane-harness" data-testid="harness-panel">
      <h2 className="section-heading">🔍 Harness 独立验证</h2>
      <p className="panel-sub">Agent 的结论不会直接决定最终结果。</p>
      <p className={`status-text ${verificationTone(session.verification?.status)}`}>
        {verificationLabel(session.verification?.status)}
      </p>
      {checks.length === 0 ? (
        <p className="empty">这次调查没有验证检查。</p>
      ) : (
        checks.map((check) => (
          <div key={check.id} className={`check ${checkTone(check.status)}`}>
            <span>{checkLabel(check)}</span>
            <span>{checkMark(check.status)}</span>
          </div>
        ))
      )}
      {coverage ? <p className="coverage">{coverage}</p> : null}
    </section>
  );
}
