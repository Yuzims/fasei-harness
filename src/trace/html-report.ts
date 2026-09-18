import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessRun } from "../core/harness.js";
import type { TraceEvent } from "./trace-collector.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function eventClass(type: string): string {
  if (type === "verification") {
    return "ev-verify";
  }
  if (type === "failure" || type === "failure_detected" || type === "failure_analyzed") {
    return "ev-fail";
  }
  if (
    type === "recovery" ||
    type === "recovery_planned" ||
    type === "recovery_started" ||
    type === "recovery_applied" ||
    type === "recovery_completed"
  ) {
    return "ev-recover";
  }
  if (type === "tool_call" || type === "tool_result") {
    return "ev-tool";
  }
  return "ev-plain";
}

function renderEvents(events: TraceEvent[]): string {
  return events
    .map((event) => {
      return `<li class="${eventClass(event.type)}">
        <div class="meta">step ${esc(event.step)} · ${esc(event.type)}</div>
        <pre>${esc(JSON.stringify(event.data, null, 2))}</pre>
      </li>`;
    })
    .join("");
}

export function renderTraceHtml(
  pageTitle: string,
  sections: Array<{ title: string; run: HarnessRun }>,
): string {
  const cards = sections
    .map((section) => {
      const pass = section.run.verification.status === "pass";
      const attempts = section.run.attempts
        .map((snapshot) => {
          const checks = snapshot.verification.checks
            .map(
              (check) =>
                `<li class="${check.passed ? "ok" : "bad"}">${esc(check.name)}: ${esc(check.reason)}</li>`,
            )
            .join("");
          return `<article class="attempt">
            <h3>第 ${esc(snapshot.attempt)} 次 · Verifier ${esc(snapshot.verification.status)}</h3>
            <p>Agent：${esc(snapshot.result.output)}</p>
            <ul class="checks">${checks}</ul>
            ${
              snapshot.failure
                ? `<p class="fail">失败类型：${esc(snapshot.failure.type)}</p>`
                : ""
            }
            ${
              snapshot.recovery
                ? `<p class="recover">恢复：${esc(snapshot.recovery.action)} — ${esc(snapshot.recovery.reason)}</p>`
                : ""
            }
          </article>`;
        })
        .join("");

      return `<section class="card ${pass ? "pass" : "fail"}">
        <header>
          <h2>${esc(section.title)}</h2>
          <span>${pass ? "最终 PASS" : "最终 FAIL"} · 恢复 ${esc(section.run.recoveryCount)} 次</span>
        </header>
        ${attempts}
        <details>
          <summary>完整 Trace</summary>
          <ol class="timeline">${renderEvents(section.run.trace)}</ol>
        </details>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(pageTitle)}</title>
  <style>
    body { font-family: sans-serif; margin: 24px; background: #0f1419; color: #e8edf2; }
    h1 { font-size: 22px; }
    .card { background: #1a222c; border: 1px solid #2c3845; border-radius: 12px; padding: 16px; margin: 16px 0; }
    .card.pass { border-color: #3dd68c; }
    .card.fail { border-color: #ff6b6b; }
    header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .attempt { background: #12181f; border-radius: 8px; padding: 12px; margin: 12px 0; }
    .ok { color: #3dd68c; }
    .bad { color: #ff6b6b; }
    .fail { color: #ffb020; }
    .recover { color: #6cb8ff; }
    .timeline { padding-left: 18px; }
    .timeline li { margin: 8px 0; }
    .meta { color: #9aa8b5; font-size: 12px; }
    pre { white-space: pre-wrap; background: #0b0f14; padding: 8px; border-radius: 6px; overflow: auto; }
  </style>
</head>
<body>
  <h1>${esc(pageTitle)}</h1>
  <p>Agent 说完成不算数。下面是 Verifier / Analyzer / Recovery 的真实轨迹。</p>
  ${cards}
</body>
</html>`;
}

export function writeTraceReport(
  filePath: string,
  pageTitle: string,
  sections: Array<{ title: string; run: HarnessRun }>,
): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderTraceHtml(pageTitle, sections), "utf8");
  return filePath;
}
