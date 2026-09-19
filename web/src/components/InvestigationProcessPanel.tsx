import type { InvestigationSessionDTO } from "@dto";
import { checkMark } from "../lib/workbench";
import { buildInvestigationResultView } from "../lib/investigation-presentation";

export function InvestigationProcessPanel({ session }: { session: InvestigationSessionDTO }) {
  const { process } = buildInvestigationResultView(session);

  return (
    <section className="panel" data-testid="process-panel">
      <h2 className="section-heading">🔎 调查过程</h2>
      {process.emptyMessage ? (
        <p className="empty">{process.emptyMessage}</p>
      ) : (
        <ol className="step-list">
          {process.steps.map((step) => (
            <li key={step.id} className={step.success ? "pass" : "fail"}>
              <span>{checkMark(step.success ? "pass" : "fail")}</span>
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
