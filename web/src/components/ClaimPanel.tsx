import type { InvestigationSessionDTO } from "@dto";
import { evidenceIdentifier, kindLabel } from "../lib/workbench";

export function ClaimPanel({ session }: { session: InvestigationSessionDTO }) {
  return (
    <section className="panel">
      <h2>Claims</h2>
      {session.claims.length === 0 ? (
        <p className="empty">No claims in this session.</p>
      ) : (
        session.claims.map((claim) => {
          const links = session.claimEvidence.filter((item) => item.claimId === claim.id);
          return (
            <article key={claim.id} className="claim">
              <div className="evidence-head">
                <span>{claim.critical ? "critical · " : ""}{claim.text}</span>
                <span className="badge">{claim.polarity}</span>
              </div>
              {links.length > 0 ? (
                <ul className="support">
                  <li>Supported by:</li>
                  {links.map((link) => {
                    const evidence = session.evidence.find((item) => item.id === link.evidenceId);
                    return (
                      <li key={`${link.claimId}-${link.evidenceId}-${link.role}`} className="mono">
                        {link.role} · {evidence ? `${kindLabel(evidence.kind)} ${evidenceIdentifier(evidence)}` : link.evidenceId}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </article>
          );
        })
      )}
    </section>
  );
}
