import type { InvestigationSessionDTO } from "@dto";
import { agentConclusion, buildInvestigationSteps, checkMark } from "../lib/workbench";

export function AgentOutput({ session }: { session: InvestigationSessionDTO }) {
  const steps = buildInvestigationSteps(session);
  const conclusion = agentConclusion(session);

  return (
    <section className="panel lane lane-agent" data-testid="agent-panel">
      <h2 className="section-heading">🤖 Agent 调查</h2>
      <p className="panel-sub">下面这些内容是 Agent 自己说的。</p>

      <div className="lane-block">
        <p className="kicker">Agent 最终结论</p>
        <p className="lane-lead">{conclusion}</p>
        {session.report.uncertainty ? <p className="muted">{session.report.uncertainty}</p> : null}
        {session.report.openQuestions.map((question) => (
          <p key={question} className="muted">
            {question}
          </p>
        ))}
      </div>

      <div className="lane-block">
        <p className="kicker">调查过程</p>
        {steps.length === 0 ? (
          <p className="empty">这次调查没有可展示的步骤。</p>
        ) : (
          <ol className="step-list">
            {steps.map((step) => (
              <li key={step.id} className={step.success ? "pass" : "fail"}>
                <span>{checkMark(step.success ? "pass" : "fail")}</span>
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <details className="inner-fold">
        <summary>查看原始 Agent 输出</summary>
        <pre className="raw-block">{session.agentOutput || conclusion}</pre>
      </details>
    </section>
  );
}
