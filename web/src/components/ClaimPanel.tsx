import type { InvestigationSessionDTO } from "@dto";
import { evidenceIdentifier, kindLabel, polarityLabel } from "../lib/workbench";

export function ClaimPanel({ session }: { session: InvestigationSessionDTO }) {
  return (
    <section className="panel">
      <h2>Claims</h2>
      {session.claims.length === 0 ? (
        <p className="empty">这次调查没有 Claim。</p>
      ) : (
        session.claims.map((claim) => {
          const links = session.claimEvidence.filter((item) => item.claimId === claim.id);
          return (
            <article key={claim.id} className="claim">
              <div className="evidence-head">
                <span>
                  {claim.critical ? "关键 · " : ""}
                  {claim.text}
                </span>
                <span className="badge">{polarityLabel(claim.polarity)}</span>
              </div>
              {links.length > 0 ? (
                <ul className="support">
                  <li>支持证据：</li>
                  {links.map((link) => {
                    const evidence = session.evidence.find((item) => item.id === link.evidenceId);
                    return (
                      <li key={`${link.claimId}-${link.evidenceId}-${link.role}`} className="mono">
                        {link.role} ·{" "}
                        {evidence ? `${kindLabel(evidence.kind)} ${evidenceIdentifier(evidence)}` : link.evidenceId}
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
