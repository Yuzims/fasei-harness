import type { InvestigationSessionDTO } from "@dto";
import { verificationLabel, verificationTone } from "../lib/workbench";

export function AgentOutput({ session }: { session: InvestigationSessionDTO }) {
  return (
    <section className="panel">
      <h2>Agent Output</h2>
      <p className="kicker">Agent conclusion</p>
      <p>{session.report.conclusion}</p>
      {session.report.uncertainty ? <p className="muted">{session.report.uncertainty}</p> : null}
      {session.report.openQuestions.map((question) => (
        <p key={question} className="muted">
          {question}
        </p>
      ))}
      <div className="agent-note">
        <p className="kicker">Independent Verification</p>
        <p className={`status-text ${verificationTone(session.verification?.status)}`}>
          {verificationLabel(session.verification?.status)}
        </p>
        <p className="muted">Agent conclusion is not the verification result.</p>
      </div>
    </section>
  );
}
