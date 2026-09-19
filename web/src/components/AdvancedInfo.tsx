import type { InvestigationSessionDTO } from "@dto";
import { actorLabel, issueRef, investigationMode, investigationModeLabel } from "../lib/workbench";
import { AttemptPanel } from "./AttemptPanel";
import { ClaimPanel } from "./ClaimPanel";
import { LlmProfilingPanel } from "./LlmProfilingPanel";
import { TraceTimeline } from "./TraceTimeline";

export function AdvancedInfo({ session }: { session: InvestigationSessionDTO }) {
  const mode = investigationMode(session);
  const checks = session.verification?.checks ?? [];

  return (
    <details className="fold" data-testid="advanced-fold">
      <summary>高级信息</summary>
      <p className="muted">以下内容保留给开发与演示，不参与最终结论。</p>

      <details className="inner-fold" open>
        <summary>Investigation Run</summary>
        <div className="detail">
          <div>
            {issueRef(session.task)} · {investigationModeLabel(mode)}
            {session.catalogId ? ` · ${session.catalogId}` : ""}
          </div>
          <div>执行者：{actorLabel(session.actor)}</div>
          <div>运行状态：{session.runStatus}</div>
          <div>调查状态：{session.status}</div>
          {session.runtimeBudget ? (
            <div>
              runtimeBudget: maxLlmCalls={session.runtimeBudget.maxLlmCalls} · maxWallClockMs=
              {session.runtimeBudget.maxWallClockMs}
            </div>
          ) : null}
        </div>
      </details>

      <AttemptPanel session={session} />
      <LlmProfilingPanel session={session} />
      <TraceTimeline session={session} />

      <details className="inner-fold">
        <summary>Evidence Graph</summary>
        {session.relations.length === 0 ? (
          <p className="empty">没有证据关系。</p>
        ) : (
          <ul className="empty-list">
            {session.relations.map((rel) => (
              <li key={`${rel.type}-${rel.fromEvidenceId}-${rel.toEvidenceId}`} className="mono">
                {rel.type} · {rel.fromEvidenceId} → {rel.toEvidenceId}
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="inner-fold">
        <summary>Verification Checks</summary>
        {checks.length === 0 ? (
          <p className="empty">没有验证检查。</p>
        ) : (
          <div className="detail">
            {checks.map((check) => (
              <div key={check.id}>
                <div>
                  {check.id} · {check.name} · {check.status}
                </div>
                {check.message ? <div className="muted">{check.message}</div> : null}
                {check.evidenceIds?.length ? (
                  <div className="mono">evidenceIds: {check.evidenceIds.join(", ")}</div>
                ) : null}
              </div>
            ))}
            {session.verification?.missingRequirementIds.length ? (
              <div className="mono">
                missingRequirementIds: {session.verification.missingRequirementIds.join(", ")}
              </div>
            ) : null}
          </div>
        )}
      </details>

      <details className="inner-fold">
        <summary>Recovery Plan / Strategy Decisions</summary>
        {session.attempts.some((item) => item.recoveryAction || item.strategy) ? (
          <div className="detail">
            {session.attempts.map((attempt) => (
              <div key={`strategy-${attempt.id}`}>
                <div>
                  Attempt {attempt.attempt}
                  {attempt.strategy ? ` · strategy=${attempt.strategy}` : ""}
                  {attempt.recoveryAction ? ` · recovery=${attempt.recoveryAction}` : ""}
                </div>
                {attempt.recoveryReason ? <div className="muted">{attempt.recoveryReason}</div> : null}
                {attempt.recoveryPlanId ? (
                  <div className="mono">recoveryPlanId={attempt.recoveryPlanId}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">没有恢复计划或策略记录。</p>
        )}
      </details>

      <ClaimPanel session={session} />

      <details className="inner-fold">
        <summary>Raw JSON</summary>
        <pre className="raw-block">{JSON.stringify(session, null, 2)}</pre>
      </details>
    </details>
  );
}
