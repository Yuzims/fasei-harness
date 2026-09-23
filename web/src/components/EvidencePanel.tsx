import { useEffect, useMemo, useState } from "react";
import type { InvestigationEvidenceDTO } from "@dto";
import {
  evidenceIdentifier,
  filterEvidence,
  kindLabel,
  sourceLabel,
  trustLabel,
  uniqueEvidenceKinds,
} from "../lib/workbench";

function EvidenceCard({
  item,
  open,
  onToggle,
}: {
  item: InvestigationEvidenceDTO;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={`evidence-card ${open ? "open" : ""}`} onClick={onToggle}>
      <div className="evidence-head">
        <strong>{kindLabel(item.kind)}</strong>
        <span className={`badge ${item.trust === "external_untrusted" ? "untrusted" : ""}`}>
          {sourceLabel(item.source)}
        </span>
      </div>
      <p style={{ margin: "6px 0 0" }}>{item.summary}</p>
      <p className="muted">
        {item.resource || item.url ? `GitHub 资源 ${evidenceIdentifier(item)}` : evidenceIdentifier(item)}
      </p>
      {open ? (
        <div className="detail">
          <div>类型：{kindLabel(item.kind)}</div>
          <div>来源：{sourceLabel(item.source)}</div>
          <div>可信状态：{trustLabel(item.trust)}</div>
          {item.resource ? <div>资源：{item.resource}</div> : null}
          {item.repository ? <div>仓库：{item.repository}</div> : null}
          {item.operation ? <div>操作：{item.operation}</div> : null}
          {item.retrievedAt ? <div>获取时间：{item.retrievedAt}</div> : null}
          {item.url ? <div className="mono">{item.url}</div> : null}
        </div>
      ) : (
        <p className="muted">展开必要出处</p>
      )}
    </button>
  );
}

export function EvidencePanel({
  evidence,
  focusEvidenceIds,
  num,
}: {
  evidence: InvestigationEvidenceDTO[];
  focusEvidenceIds: string[];
  num: number;
}) {
  const kinds = uniqueEvidenceKinds(evidence);
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState<string>();
  const [panelOpen, setPanelOpen] = useState(false);
  const items = useMemo(
    () => filterEvidence(evidence, kinds.includes(filter) ? filter : "all"),
    [filter, kinds, evidence],
  );

  useEffect(() => {
    if (focusEvidenceIds.length === 0) {
      return;
    }
    setPanelOpen(true);
    setFilter("all");
    setOpenId(focusEvidenceIds[0]);
  }, [focusEvidenceIds]);

  return (
    <details
      className="phase"
      data-testid="evidence-fold"
      open={panelOpen}
      onToggle={(event) => setPanelOpen(event.currentTarget.open)}
    >
      <summary className="phase-head">
        <span className="phase-num">{num}</span>
        证据（调查收集到的 {evidence.length} 条 GitHub 原始记录）
        <span className="tag">（点击展开）</span>
      </summary>
      <div className="phase-body">
      <p className="muted">证据是事实来源，不是 Agent 判断。</p>
      <div className="filters">
        <button
          type="button"
          className={filter === "all" ? "chip active" : "chip"}
          onClick={() => setFilter("all")}
        >
          全部
        </button>
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            className={filter === kind ? "chip active" : "chip"}
            onClick={() => setFilter(kind)}
          >
            {kindLabel(kind)}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="empty">这次调查没有证据。</p>
      ) : (
        <div className="evidence-list">
          {items.map((item) => (
            <EvidenceCard
              key={item.id}
              item={item}
              open={openId === item.id}
              onToggle={() => setOpenId(openId === item.id ? undefined : item.id)}
            />
          ))}
        </div>
      )}
      </div>
    </details>
  );
}
