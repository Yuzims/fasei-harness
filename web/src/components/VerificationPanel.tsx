import type { InvestigationSessionDTO } from "@dto";
import {
  checkMark,
  checkTone,
  satisfiedCount,
  verificationLabel,
  verificationSubtitle,
  verificationTone,
} from "../lib/workbench";

export function VerificationSummary({ session }: { session: InvestigationSessionDTO }) {
  const status = session.verification?.status;
  const tone = verificationTone(status);
  const counts = satisfiedCount(session);

  return (
    <section className={`banner ${tone}`}>
      <div className="banner-meta">
        <div>
          <p className="kicker">Independent verification</p>
          <h2 className="banner-title">{verificationLabel(status)}</h2>
          <p className="muted">{verificationSubtitle(status)}</p>
        </div>
        {counts.total > 0 ? (
          <p className="mono">
            {counts.passed} / {counts.total} requirements satisfied
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function VerificationChecks({ session }: { session: InvestigationSessionDTO }) {
  return (
    <section className="panel">
      <h2>Verification</h2>
      {(session.verification?.checks ?? []).length === 0 ? (
        <p className="empty">No verification checks in this session.</p>
      ) : (
        session.verification?.checks.map((check) => (
          <div key={check.id} className={`check ${checkTone(check.status)}`}>
            <span>{checkMark(check.status)}</span>
            <span>
              {check.name}
              {check.message ? <span className="muted"> · {check.message}</span> : null}
            </span>
          </div>
        ))
      )}
    </section>
  );
}
