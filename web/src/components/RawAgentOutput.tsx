import type { InvestigationSessionDTO } from "@dto";
import { rawAgentOutputText } from "../lib/investigation-presentation";

export function RawAgentOutput({ session }: { session: InvestigationSessionDTO }) {
  const output = rawAgentOutputText(session);
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
