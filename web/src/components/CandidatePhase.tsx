import type { ConclusionNarrativeView } from "../lib/candidate-presentation";

export function CandidatePhase({ narrative }: { narrative: ConclusionNarrativeView }) {
  if (narrative.rows.length === 0 && !narrative.summaryLine) {
    return null;
  }
  return (
    <details className="phase" id="related-prs" data-testid="candidate-phase">
      <summary>
        <div className="phase-head">
          <span className="phase-num">2</span>
          相关修复 PR
          <span className="tag">
            {narrative.rowsTag}
            {narrative.rows.length > 0 ? `（点击展开 ${narrative.rows.length} 条明细）` : ""}
          </span>
        </div>
      </summary>
      {narrative.rows.map((row) => (
        <div className="step" key={row.key} data-testid={`candidate-row-${row.key}`}>
          <span className="mark">·</span>
          <span className="res">{row.numberLabel}</span>
          {row.title ? (
            <span>{row.statusText ? `${row.title} · ${row.statusText}` : row.title}</span>
          ) : row.statusText ? <span>{row.statusText}</span> : null}
          <span className="muted">—— {row.reasonText}</span>
        </div>
      ))}
      {narrative.summaryLine ? <div className="agg">{narrative.summaryLine}</div> : null}
    </details>
  );
}

export function HintsPhase({ narrative }: { narrative: ConclusionNarrativeView }) {
  if (narrative.hints.length === 0 || !narrative.hintsLead) {
    return null;
  }
  return (
    <div className="phase" data-testid="hints-phase">
      <div className="phase-head">
        <span className="phase-num">3</span>
        未关联修复线索
        <span className="tag">仅提示 · 不改变上面第 1 节的结论</span>
      </div>
      <div className="agg">{narrative.hintsLead}</div>
      {narrative.hints.map((hint) => (
        <div className="step" key={hint.sha} data-testid={`hint-row-${hint.shortSha}`}>
          <span className="mark">·</span>
          {hint.url ? (
            <a className="mono" href={hint.url} target="_blank" rel="noreferrer">
              {hint.shortSha}
            </a>
          ) : (
            <span className="mono">{hint.shortSha}</span>
          )}
          <span>
            · 触及文件：{hint.files.join("、")}{" "}
            {hint.url ? (
              <a href={hint.url} target="_blank" rel="noreferrer">
                在 GitHub 打开 ↗
              </a>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
