import { useEffect, useState, type ReactNode } from "react";
import { checkMark } from "../lib/workbench";
import type { LiveItemState, LiveProcessItem, LiveStreamState } from "../lib/investigation-stream";
import type { InvestigationResultViewModel } from "../lib/investigation-presentation";

function stepMarker(state: LiveItemState): string {
  if (state === "active") {
    return "⟳";
  }
  return checkMark(state === "pass" ? "pass" : state === "fail" ? "fail" : "warn");
}

function StepRow({ item }: { item: LiveProcessItem }) {
  if (item.state === "active") {
    return (
      <div className="live">
        ⟳ {item.label}
        <span className="dot">▍</span>
      </div>
    );
  }
  const tone = item.state === "pass" ? "ok" : item.state === "fail" ? "no" : undefined;
  return (
    <div className={`step ${tone ?? ""}`.trim()}>
      <span className="mark">{stepMarker(item.state)}</span>
      <span>
        {item.label}
        {item.count && item.count > 1 ? ` ×${item.count}` : ""}
      </span>
    </div>
  );
}

function AggRow({ item }: { item: LiveProcessItem }) {
  return <div className="agg">{item.label}</div>;
}

function LivePhaseSection({
  num,
  title,
  tag,
  testId,
  collapsible,
  children,
}: {
  num: number;
  title: string;
  tag: string;
  testId: string;
  collapsible?: boolean;
  children: ReactNode;
}) {
  if (!collapsible) {
    return (
      <div className="phase" data-testid={testId}>
        <div className="phase-head">
          <span className="phase-num">{num}</span> {title} <span className="tag">{tag}</span>
        </div>
        <div className="phase-body">{children}</div>
      </div>
    );
  }
  return (
    <details className="phase" data-testid={testId}>
      <summary className="phase-head">
        <span className="phase-num">{num}</span> {title} <span className="tag">{tag}</span>
      </summary>
      <div className="phase-body">{children}</div>
    </details>
  );
}

function elapsedText(state: LiveStreamState, now: number): string | undefined {
  if (!state.startedAtMs) {
    return undefined;
  }
  const seconds = Math.max(0, Math.round((now - state.startedAtMs) / 1000));
  const budget = state.maxLlmCalls ? `（共 ${state.maxLlmCalls} 步预算）` : "";
  return `已用时 ${seconds}s · AI 已思考 ${state.thoughtSteps} 步${budget}`;
}

function LivePanelBody({ state }: { state: LiveStreamState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const items = state.items;
  const prescanHead = items.find((item) => item.phase === "prescan" && item.kind === "head");
  const prescanAggs = items.filter((item) => item.phase === "prescan" && item.kind === "agg");
  const prescanRaw = items.filter((item) => item.phase === "prescan" && !item.kind);
  const agentItems = items.filter((item) => item.phase === "agent");
  const verificationItems = items.filter((item) => item.phase === "verification");

  const prescanSkipped = !prescanHead && prescanRaw.length === 0 && agentItems.length > 0;
  const prescanTag = prescanHead
    ? `${prescanHead.label}（点击展开 ${prescanAggs.length + prescanRaw.length} 条明细）`
    : prescanSkipped
      ? "本次调查未运行机器预扫描"
      : "进行中……";

  return (
    <>
      <div className="panel-head">
        <b>调查过程</b>
        {elapsedText(state, now) ? <span className="elapsed">{elapsedText(state, now)}</span> : null}
      </div>

      {prescanHead ? (
        <LivePhaseSection num={1} title="机器预扫描" tag={prescanTag} testId="live-phase-prescan" collapsible>
          {prescanAggs.map((item) => (
            <AggRow key={item.id} item={item} />
          ))}
          {prescanRaw.map((item) => (
            <StepRow key={item.id} item={item} />
          ))}
        </LivePhaseSection>
      ) : (
        <LivePhaseSection num={1} title="机器预扫描" tag={prescanTag} testId="live-phase-prescan">
          {prescanRaw.length > 0 ? (
            prescanRaw.map((item) => <StepRow key={item.id} item={item} />)
          ) : (
            <div className="agg muted">
              {prescanSkipped ? "该场景为录制的快照重放，机器预扫描不适用。" : "正在读取 Issue 正文与评论……"}
            </div>
          )}
        </LivePhaseSection>
      )}

      <LivePhaseSection
        num={2}
        title="Agent 调查"
        tag="逐轮进行，每轮 AI 思考一次"
        testId="live-phase-agent"
      >
        {agentItems.length > 0 ? (
          agentItems.map((item) => <StepRow key={item.id} item={item} />)
        ) : (
          <div className="agg muted">（等待中——机器预扫描完成后开始主动调查）</div>
        )}
      </LivePhaseSection>

      <LivePhaseSection
        num={3}
        title="独立验证"
        tag="Agent 结束调查后运行，逐项判定"
        testId="live-phase-verification"
      >
        {verificationItems.length > 0 ? (
          verificationItems.map((item) => <StepRow key={item.id} item={item} />)
        ) : (
          <div className="agg muted">（等待中——完成后这里逐条出现检查项，与结果页「验证明细」同源）</div>
        )}
      </LivePhaseSection>
    </>
  );
}

export function InvestigationProcessPanel({
  view,
  live,
}: {
  view?: InvestigationResultViewModel;
  live?: { state: LiveStreamState };
}) {
  if (live) {
    return (
      <section className="panel" data-testid="process-panel" aria-live="polite">
        <LivePanelBody state={live.state} />
      </section>
    );
  }

  const process = view?.process;

  return (
    <section className="panel" data-testid="process-panel">
      <h2 className="section-heading">🔎 调查过程</h2>
      {!process || process.emptyMessage ? (
        <p className="empty">{process?.emptyMessage ?? "暂无调查过程。"}</p>
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
