import type { InvestigationResultViewModel } from "../lib/investigation-presentation";

export function ResultHero({ view }: { view: InvestigationResultViewModel }) {
  const { verdict } = view;
  const counts = [
    verdict.counts.pass > 0 ? `✓ ${verdict.counts.pass} 项通过` : undefined,
    verdict.counts.fail > 0 ? `✗ ${verdict.counts.fail} 项未通过` : undefined,
    verdict.counts.unknown > 0 ? `? ${verdict.counts.unknown} 项待确认` : undefined,
  ].filter(Boolean);

  return (
    <section className={`hero-verdict ${view.tone}`} data-testid="result-hero">
      <p className="kicker">调查结果 · {view.issueLine}</p>
      <h2 className="hero-title" data-testid="hero-status">
        {view.statusLabel}
      </h2>
      <p className="hero-summary">{view.summary}</p>

      <div className="hero-block">
        <p className="kicker">为什么</p>
        <p className="hero-why" data-testid="hero-why">
          {verdict.why}
        </p>
      </div>

      {verdict.gaps.length > 0 ? (
        <div className="hero-block" data-testid="hero-gaps">
          <p className="kicker">还差什么</p>
          <ul className="gap-list">
            {verdict.gaps.map((gap) => (
              <li key={gap.id}>
                <span className={`gap-mark ${view.status === "not_verified" ? "fail" : "warn"}`}>
                  {gap.mark}
                </span>
                <span className="gap-label">{gap.label}</span>
                {gap.explanation ? <p className="muted">{gap.explanation}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {counts.length > 0 ? <p className="hero-counts muted">{counts.join(" · ")}</p> : null}
    </section>
  );
}
