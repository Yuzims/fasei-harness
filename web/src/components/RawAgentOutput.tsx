import type { InvestigationResultViewModel } from "../lib/investigation-presentation";

export function RawAgentOutput({ view }: { view: InvestigationResultViewModel }) {
  const output = view.rawAgentOutput;
  if (!output) {
    return null;
  }

  return (
    <details className="fold" data-testid="raw-agent-fold">
      <summary>▶ 查看原始 Agent 输出</summary>
      <pre className="raw-block">{output}</pre>
    </details>
  );
}
