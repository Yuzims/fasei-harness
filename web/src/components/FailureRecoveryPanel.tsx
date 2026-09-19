import type { InvestigationSessionDTO } from "@dto";
import { investigationIncident } from "../lib/investigation-presentation";

export function FailureRecoveryPanel({ session }: { session: InvestigationSessionDTO }) {
  const incident = investigationIncident(session);
  if (!incident) {
    return null;
  }

  return (
    <section
      className={`panel incident-panel ${incident.kind}`}
      data-testid="incident-panel"
      data-incident-kind={incident.kind}
    >
      <h2 className="section-heading">
        {incident.kind === "process" ? "⚠️ 调查过程中遇到问题" : `⚠️ ${incident.title}`}
      </h2>
      <p>{incident.summary}</p>

      {incident.recoverySummary ? (
        <div className="lane-block">
          <p className="kicker">{incident.recoveryTitle ?? "恢复策略"}</p>
          <p>{incident.recoverySummary}</p>
        </div>
      ) : null}

      {incident.nextEvidence.length > 0 ? (
        <div className="lane-block">
          <p className="kicker">下一步需要确认的证据</p>
          <ul className="empty-list">
            {incident.nextEvidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
