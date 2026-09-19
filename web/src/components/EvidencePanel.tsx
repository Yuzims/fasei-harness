import { useMemo, useState } from "react";
import type { InvestigationEvidenceDTO, InvestigationSessionDTO } from "@dto";
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
  session,
  open,
  onToggle,
}: {
  item: InvestigationEvidenceDTO;
  session: InvestigationSessionDTO;
  open: boolean;
  onToggle: () => void;
}) {
  const relations = session.relations.filter(
    (rel) => rel.fromEvidenceId === item.id || rel.toEvidenceId === item.id,
  );

  return (
    <button type="button" className={`evidence-card ${open ? "open" : ""}`} onClick={onToggle}>
      <div className="evidence-head">
        <strong>{kindLabel(item.kind)}</strong>
        <span className={`badge ${item.trust === "external_untrusted" ? "untrusted" : ""}`}>
          {trustLabel(item.trust)}
        </span>
      </div>
      <p className="muted">
        来源 {sourceLabel(item.source)} · 类型 {kindLabel(item.kind)}
      </p>
      <p style={{ margin: "6px 0 0" }}>{item.summary}</p>
      {open ? (
        <div className="detail">
          <div>摘要：{item.summary}</div>
          <div>可信状态：{trustLabel(item.trust)}</div>
          <div className="mono">{evidenceIdentifier(item)}</div>
          <div>id: {item.id}</div>
          {item.operation ? <div>operation: {item.operation}</div> : null}
          {item.resource ? <div>resource: {item.resource}</div> : null}
          {item.repository ? <div>repository: {item.repository}</div> : null}
          {item.retrievedAt ? <div>retrievedAt: {item.retrievedAt}</div> : null}
          {item.url ? <div>url: {item.url}</div> : null}
          {relations.length > 0 ? (
            <div>
              relations:{" "}
              {relations
                .map((rel) => `${rel.type} ${rel.fromEvidenceId} → ${rel.toEvidenceId}`)
                .join("; ")}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="muted">展开详情</p>
      )}
    </button>
  );
}

export function EvidencePanel({ session }: { session: InvestigationSessionDTO }) {
  const kinds = uniqueEvidenceKinds(session.evidence);
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState<string>();
  const items = useMemo(
    () => filterEvidence(session.evidence, kinds.includes(filter) ? filter : "all"),
    [filter, kinds, session.evidence],
  );

  return (
    <details className="fold" data-testid="evidence-fold">
      <summary>📎 证据（{session.evidence.length}）</summary>
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
              session={session}
              open={openId === item.id}
              onToggle={() => setOpenId(openId === item.id ? undefined : item.id)}
            />
          ))}
        </div>
      )}
    </details>
  );
}
