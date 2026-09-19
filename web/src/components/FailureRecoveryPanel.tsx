import type { InvestigationSessionDTO } from "@dto";
import {
  failureTypeLabel,
  latestFailure,
  nextEvidenceTargets,
  recoveryActionLabel,
} from "../lib/workbench";

export function FailureRecoveryPanel({ session }: { session: InvestigationSessionDTO }) {
  const failure = latestFailure(session);
  if (!failure) {
    return null;
  }

  const nextTargets = nextEvidenceTargets(failure.missingRequirementIds);

  return (
    <section className="panel failure-panel" data-testid="failure-panel">
      <h2 className="section-heading">⚠ 调查失败</h2>
      <p className="lane-lead">{failureTypeLabel(failure.failureType)}</p>
      {failure.failureReason ? <p className="muted">{failure.failureReason}</p> : null}

      {failure.recoveryAction ? (
        <div className="lane-block">
          <p className="kicker">恢复策略</p>
          <p>{recoveryActionLabel(failure.recoveryAction)}</p>
          {failure.recoveryReason ? <p className="muted">{failure.recoveryReason}</p> : null}
        </div>
      ) : null}

      {nextTargets.length > 0 ? (
        <div className="lane-block">
          <p className="kicker">下一步需要确认的证据</p>
          <ul className="empty-list">
            {nextTargets.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {failure.recoveryNextStep ? <p className="muted">{failure.recoveryNextStep}</p> : null}
    </section>
  );
}
