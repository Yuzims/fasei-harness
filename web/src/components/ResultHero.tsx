import type { ReactNode } from "react";
import type { InvestigationResultViewModel } from "../lib/investigation-presentation";
import { CandidatePhase, HintsPhase } from "./CandidatePhase";

export function ResultHero({ view, children }: { view: InvestigationResultViewModel; children?: ReactNode }) {
  const { verdict, narrative } = view;
  const counts = [
    verdict.counts.pass > 0 ? `✓ ${verdict.counts.pass} 项通过` : undefined,
    verdict.counts.fail > 0 ? `✗ ${verdict.counts.fail} 项未通过` : undefined,
    verdict.counts.unknown > 0 ? `? ${verdict.counts.unknown} 项待确认` : undefined,
  ].filter(Boolean);
  const marker = narrative ? narrative.marker : view.coverage?.marker;

  return (
    <section className="panel" data-testid="result-hero">
      <div className="panel-head">
        <b>调查结果 · {view.issueRefLine}</b>
        <span className="elapsed" data-testid="hero-counts">
          {counts.join(" · ")}
        </span>
      </div>

      <div className="phase" data-testid="conclusion-phase">
        <div className="phase-head">
          <span className="phase-num">1</span>
          <span data-testid="hero-status">
            {narrative ? narrative.phaseTitle : `结论 · ${view.statusLabel}`}
          </span>
          {marker ? (
            <span className="tag" data-testid="hero-coverage-marker">
              {marker}
            </span>
          ) : null}
        </div>
        {narrative ? (
          <>
            <div className="agg" data-testid="hero-headline">
              <b>{narrative.headline}</b>
            </div>
            <div className="agg">{narrative.uncertainty}</div>
          </>
        ) : (
          <div className="agg" data-testid="hero-summary">
            {view.summary}
          </div>
        )}
        {view.issueTitle ? (
          <div className="agg" data-testid="hero-bug-line">
            Bug: {view.issueTitle}
            {view.issueUrl ? (
              <>
                {" · "}
                <a href={view.issueUrl} target="_blank" rel="noreferrer">
                  打开
                </a>
              </>
            ) : null}
          </div>
        ) : null}
        {narrative && narrative.whyBullets.length > 0 ? (
          <>
            <div className="agg">
              <b>为什么</b>
            </div>
            {narrative.whyBullets.map((bullet) => (
              <div className="agg" key={bullet}>
                · {bullet}
              </div>
            ))}
          </>
        ) : null}
        {narrative && narrative.nextBullets.length > 0 ? (
          <>
            <div className="agg">
              <b>接下来</b>
            </div>
            {narrative.nextBullets.map((bullet) => (
              <div className="agg" key={bullet}>
                · {bullet}
              </div>
            ))}
          </>
        ) : null}
        {narrative?.guidance ? (
          <div className="agg" data-testid="hero-guidance">
            {narrative.guidance}
            {"，"}
            <a href="#related-prs">详见「相关修复 PR」</a>
          </div>
        ) : null}
      </div>

      {narrative ? <CandidatePhase narrative={narrative} /> : null}
      {narrative ? <HintsPhase narrative={narrative} /> : null}
      {children}
    </section>
  );
}

/** 证据/验证明细/Agent 输出三个折叠块在面板内的序号，跟随已渲染的前置阶段数量。 */
export function tailPhaseNumbers(view: InvestigationResultViewModel): { evidence: number; verification: number; agent: number } {
  const n = view.narrative;
  let next = 2;
  if (n && (n.rows.length > 0 || n.summaryLine)) {
    next += 1;
  }
  if (n && n.hints.length > 0 && n.hintsLead) {
    next += 1;
  }
  return { evidence: next, verification: next + 1, agent: next + 2 };
}
