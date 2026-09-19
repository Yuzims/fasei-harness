import type { InvestigationSessionDTO } from "@dto";
import {
  failureTypeLabel,
  recoveredFrom,
  recoveryActionLabel,
  verificationLabel,
  verificationTone,
} from "../lib/workbench";

export function AttemptPanel({ session }: { session: InvestigationSessionDTO }) {
  if (session.attempts.length === 0) {
    return null;
  }

  return (
    <section className="panel">
      <h2>Attempts</h2>
      {session.attempts.map((attempt, index) => {
        const parent = recoveredFrom(attempt, session.attempts);
        return (
          <div key={attempt.id}>
            {index > 0 ? <div className="attempt-arrow">↓</div> : null}
            <article className="attempt">
              <div className="evidence-head">
                <strong>第 {attempt.attempt} 轮</strong>
                <span className={`status-text ${verificationTone(attempt.verificationStatus)}`}>
                  {attempt.status ?? attempt.verificationStatus ?? "unknown"}
                </span>
              </div>
              {parent ? <p className="muted">恢复自第 {parent.attempt} 轮</p> : null}
              {attempt.strategy ? <p className="muted">strategy: {attempt.strategy}</p> : null}
              {attempt.verificationStatus ? (
                <p className={`status-text ${verificationTone(attempt.verificationStatus)}`}>
                  验证：{verificationLabel(attempt.verificationStatus)}
                </p>
              ) : null}
              {attempt.failureType ? (
                <div>
                  <p className="kicker" style={{ marginTop: 8 }}>
                    Failure
                  </p>
                  <p className="status-text not_verified">{failureTypeLabel(attempt.failureType)}</p>
                  {attempt.failureReason ? <p>{attempt.failureReason}</p> : null}
                  {attempt.failureTool ? <p className="muted">tool: {attempt.failureTool}</p> : null}
                  {attempt.failureErrorCode ? (
                    <p className="muted">errorCode: {attempt.failureErrorCode}</p>
                  ) : null}
                  {attempt.missingRequirementIds && attempt.missingRequirementIds.length > 0 ? (
                    <p className="muted">
                      missingRequirementIds: {attempt.missingRequirementIds.join(", ")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {attempt.recoveryAction ? (
                <div>
                  <p className="kicker" style={{ marginTop: 8 }}>
                    Recovery Plan
                  </p>
                  <p>{recoveryActionLabel(attempt.recoveryAction)}</p>
                  {attempt.recoveryReason ? <p className="muted">{attempt.recoveryReason}</p> : null}
                  {attempt.recoveryNextStep ? (
                    <p className="muted">next: {attempt.recoveryNextStep}</p>
                  ) : null}
                </div>
              ) : null}
              {(attempt.parentAttemptId || attempt.recoveryPlanId || attempt.failureEventId) && (
                <div className="muted mono">
                  {attempt.parentAttemptId ? <div>parentAttemptId={attempt.parentAttemptId}</div> : null}
                  {attempt.recoveryPlanId ? <div>recoveryPlanId={attempt.recoveryPlanId}</div> : null}
                  {attempt.failureEventId ? <div>failureEventId={attempt.failureEventId}</div> : null}
                </div>
              )}
              <p className="muted">
                evidence added: {attempt.evidenceIds.length} · claims: {attempt.claimIds.length}
              </p>
            </article>
          </div>
        );
      })}
    </section>
  );
}
