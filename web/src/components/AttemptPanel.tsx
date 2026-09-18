import type { InvestigationSessionDTO } from "@dto";
import { recoveredFrom, verificationLabel, verificationTone } from "../lib/workbench";

export function AttemptPanel({ session }: { session: InvestigationSessionDTO }) {
  if (session.attempts.length === 0) {
    return null;
  }

  return (
    <section className="panel">
      <h2>Attempts / Failure / Recovery</h2>
      {session.attempts.map((attempt, index) => {
        const parent = recoveredFrom(attempt, session.attempts);
        return (
          <div key={attempt.id}>
            {index > 0 ? <div className="attempt-arrow">↓</div> : null}
            <article className="attempt">
              <div className="evidence-head">
                <strong>Attempt {attempt.attempt}</strong>
                <span className={`status-text ${verificationTone(attempt.verificationStatus)}`}>
                  {attempt.status ?? attempt.verificationStatus ?? "unknown"}
                </span>
              </div>
              {parent ? (
                <p className="muted">Recovered from Attempt {parent.attempt}</p>
              ) : null}
              {attempt.strategy ? <p className="muted">strategy: {attempt.strategy}</p> : null}
              {attempt.verificationStatus ? (
                <p className={`status-text ${verificationTone(attempt.verificationStatus)}`}>
                  Verification: {verificationLabel(attempt.verificationStatus)}
                </p>
              ) : null}
              {attempt.failureType ? (
                <div>
                  <p className="kicker" style={{ marginTop: 8 }}>
                    Failure
                  </p>
                  <p className="status-text not_verified">{attempt.failureType}</p>
                  {attempt.failureReason ? <p>{attempt.failureReason}</p> : null}
                  {attempt.failureTool ? <p className="muted">tool: {attempt.failureTool}</p> : null}
                  {attempt.failureErrorCode ? (
                    <p className="muted">errorCode: {attempt.failureErrorCode}</p>
                  ) : null}
                  {attempt.missingRequirementIds && attempt.missingRequirementIds.length > 0 ? (
                    <p className="muted">
                      evidence gap: {attempt.missingRequirementIds.join(", ")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {attempt.recoveryAction ? (
                <div>
                  <p className="kicker" style={{ marginTop: 8 }}>
                    Recovery
                  </p>
                  <p>Recovery Plan: {attempt.recoveryAction}</p>
                  {attempt.recoveryReason ? <p className="muted">{attempt.recoveryReason}</p> : null}
                  {attempt.recoveryNextStep ? (
                    <p className="muted">next: {attempt.recoveryNextStep}</p>
                  ) : null}
                </div>
              ) : null}
              {(attempt.parentAttemptId || attempt.recoveryPlanId || attempt.failureEventId) && (
                <p className="muted mono">
                  {attempt.parentAttemptId ? `parentAttemptId=${attempt.parentAttemptId} ` : ""}
                  {attempt.recoveryPlanId ? `recoveryPlanId=${attempt.recoveryPlanId} ` : ""}
                  {attempt.failureEventId ? `failureEventId=${attempt.failureEventId}` : ""}
                </p>
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
