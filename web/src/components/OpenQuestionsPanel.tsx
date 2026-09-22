import type { InvestigationResultViewModel } from "../lib/investigation-presentation";

export function OpenQuestionsPanel({ view }: { view: InvestigationResultViewModel }) {
  if (view.openQuestions.length === 0) {
    return null;
  }

  return (
    <section className="panel" data-testid="open-questions-panel">
      <h2 className="section-heading">❓ 待确认事项</h2>
      <p className="panel-sub">以下问题来自调查结果与 Agent 分析，合并去重后仍待确认。</p>
      <ul className="empty-list">
        {view.openQuestions.map((question) => (
          <li key={question}>{question}</li>
        ))}
      </ul>
    </section>
  );
}
