/**
 * Phase 19-B copy snapshot tests. Every asserted sentence is a fixed
 * field-template from web/src/lib/candidate-presentation.ts, replayed against
 * the real react#37610 fixtures (state one) and a synthetic mid-run DTO
 * (state three). The jargon scan locks the mockup's visible-copy ban list.
 * Runner deviation noted in the delivery report: the repo uses node:test,
 * not vitest, so these live here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { InvestigationSessionDTO, ResolutionPrescanCandidateDTO } from "../src/api/dto.ts";
import { SnapshotGitHubProvider, githubFixturePath } from "../src/github/index.ts";
import type { ClosingReferenceFacts } from "../src/github/index.ts";
import { normalizeIssue } from "../src/github/normalize.ts";
import { investigate } from "../src/investigation/index.ts";
import { toInvestigationSessionDTO } from "../src/server/investigation-service.ts";
import { buildConclusionNarrative } from "../web/src/lib/candidate-presentation.ts";
import { buildInvestigationResultView } from "../web/src/lib/investigation-presentation.ts";

function closingRefsFixture(): { repositoryNameWithOwner?: string; facts: ClosingReferenceFacts[] } {
  const url = new URL("../fixtures/github/react-37610-closing-refs.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as {
    repositoryNameWithOwner?: string;
    facts: ClosingReferenceFacts[];
  };
}

function fixtureGraphQl() {
  const fixture = closingRefsFixture();
  return {
    async getClosingReferences({ pullNumbers }: { pullNumbers: number[] }) {
      return {
        repositoryNameWithOwner: fixture.repositoryNameWithOwner,
        facts: fixture.facts.filter((fact) => pullNumbers.includes(fact.pullNumber)),
      };
    },
  };
}

async function replaySession(): Promise<InvestigationSessionDTO> {
  const report = await investigate({
    task: { owner: "facebook", repository: "react", issueNumber: 37610 },
    provider: new SnapshotGitHubProvider(githubFixturePath("react-37610")),
    model: {
      async decide() {
        return { type: "final" as const, message: "Prescan already gave me the candidate set." };
      },
    },
    resolutionPrescan: {
      enabled: true as const,
      graphQl: fixtureGraphQl(),
    },
    maxAttempts: 1,
  });
  return toInvestigationSessionDTO(report, { mode: "snapshot", catalogId: "react-37610", group: "real-v1" });
}

function rowOf(session: InvestigationSessionDTO, pullNumber: number) {
  const narrative = buildConclusionNarrative(session);
  assert.ok(narrative, "narrative must exist for the replayed react#37610 session");
  const row = narrative.rows.find((item) => item.key === `pr-${pullNumber}`);
  assert.ok(row, `row for #${pullNumber} must exist`);
  return row;
}

test("19-B.1 DTO 投影：prescan 候选 + GitHub 标题原文直出 + issue createdAt", async () => {
  const session = await replaySession();
  const prescan = session.resolutionPrescan;
  assert.ok(prescan, "resolutionPrescan must be projected into the session DTO");
  assert.equal(prescan.candidates.length, 10);
  assert.equal(prescan.candidates[0].pullNumber, 37626, "官方关闭引用排最前");
  assert.equal(prescan.candidates[0].title, "[DOM] Keep Fragment sibling positions stable across renders");
  assert.equal(session.issue.createdAt, "2026-09-12T05:58:33Z");
  const byNumber = new Map(prescan.candidates.map((c) => [c.pullNumber, c]));
  assert.equal(byNumber.get(32722)?.title, "Add compareDocumentPosition to fragment instances");
  assert.equal(byNumber.get(34069)?.title, "Fix fragmentInstance#compareDocumentPosition nesting and portal cases");
  assert.equal(byNumber.get(37142)?.title, "[Fragment Refs] Fix DOM/Fiber containment validation");
  assert.equal(byNumber.get(37162)?.title, "[DOM] Find host siblings for nested empty Fragments");
  assert.equal(byNumber.get(37163)?.title, "[DOM] Fix Fragment compareDocumentPosition for documentElement and empty portals");
  assert.equal(byNumber.get(37579)?.title, "[DOM] Fix Fragment compareDocumentPosition(document) TypeError");
  assert.equal(byNumber.get(37607)?.title, "[DOM] Handle non-element portal roots in Fragment document position");
  assert.equal(byNumber.get(37578)?.title, undefined, "非 PR 编号没有标题");
  assert.equal(byNumber.get(37606)?.title, undefined);
});

test("19-B.2 候选行模板（状态一）：编号 · 标题 · 状态日期 · 记录级理由", async () => {
  const session = await replaySession();
  assert.deepEqual(
    buildConclusionNarrative(session)!.rows.map((row) => row.key),
    [
      "pr-37626",
      "pr-32722",
      "pr-34069",
      "pr-37142",
      "pr-37162",
      "pr-37163",
      "pr-37578",
      "pr-37579",
      "pr-37606",
      "pr-37607",
    ],
  );

  const best = rowOf(session, 37626);
  assert.equal(best.numberLabel, "PR #37626");
  assert.equal(best.statusText, "未合并（2026-09-14 创建）");
  assert.equal(best.reasonText, "官方标记将关闭本 Issue，目前最可能真正修好它的一个");

  const pre = rowOf(session, 32722);
  assert.equal(pre.statusText, "已合并 2025-05-06");
  assert.equal(
    pre.reasonText,
    "于 2025-05-06 合并，早于本 Issue 提出（2026-09-12），GitHub 记录中也未登记为修复本 Issue",
  );

  const cause = rowOf(session, 34069);
  assert.equal(
    cause.reasonText,
    "于 2025-08-15 合并，早于本 Issue 提出（2026-09-12），GitHub 记录中也未登记为修复本 Issue",
  );

  const unrelated = rowOf(session, 37142);
  assert.equal(unrelated.statusText, "未合并（2026-07-29 创建）");
  assert.equal(unrelated.reasonText, "与本 Issue 没有官方修复关联，仅作线索");

  const nonPr = rowOf(session, 37578);
  assert.equal(nonPr.numberLabel, "#37578");
  assert.equal(nonPr.title, undefined);
  assert.equal(nonPr.reasonText, "GitHub 确认该编号不是 Pull Request，排除");
});

test("19-B.3 结论区固定模板句（状态一）与 mockup 文案逐句一致", async () => {
  const session = await replaySession();
  const narrative = buildConclusionNarrative(session);
  assert.ok(narrative);
  assert.equal(narrative.phaseTitle, "结论 · 修复还没完成");
  assert.equal(narrative.marker, undefined);
  assert.equal(narrative.headline, "官方修复 PR #37626 已于 9 月 14 日提交，至今未合并进主干，Issue 也仍挂着。");
  assert.equal(
    narrative.uncertainty,
    "但也不能断定 bug 还在：修复可能已经生效，只是 GitHub 记录上没走完——最终以维护者关闭 Issue 或实际行为验证为准。",
  );
  assert.deepEqual(narrative.whyBullets, [
    "GitHub 官方记录里，只有 PR #37626（[DOM] Keep Fragment sibling positions stable across renders）被标记为修复本 Issue，但它还在等待评审合并。",
    "其余已合并的相关 PR（#32722、#34069、#37162、#37163、#37579）全部在本 Issue 提出之前合并，GitHub 记录里也都没有登记为修复本 Issue。也不排除其中某个 PR 已修复主干上的问题而报告者所用版本较旧——确认需要核对版本发版时间，目前证据里没有。",
    "另有 2 个未合并的 PR（#37142、#37607）与本 Issue 没有官方关联，只能作为线索；#37578、#37606 两个编号不是 PR。",
    "Issue 至今没人关闭。",
  ]);
  assert.deepEqual(narrative.nextBullets, [
    "等 #37626 通过评审、合并进主干，维护者关闭 Issue，结论就会变成「已解决」。",
    "如果急需可用的修复，可以先试装 #37626 的分支验证效果。",
  ]);
  assert.equal(
    narrative.guidance,
    "🔎 最接近修好的：PR #37626（官方标记将关闭本 Issue，尚未合并）—— 10 个相关 PR 已全部核对",
  );
  assert.equal(
    narrative.rowsTag,
    "机器预扫描找到 10 个，已全部核对（0 次 AI 调用）· 排序：官方标记修复本 Issue 的排最前",
  );
  assert.equal(narrative.summaryLine, undefined);
});

test("19-B.4 未关联修复线索行：文案 + 短 SHA + GitHub 链接", () => {
  const session = midRunSession();
  const narrative = buildConclusionNarrative(session);
  assert.ok(narrative);
  assert.equal(
    narrative.hintsLead,
    "在主干分支上、本 Issue 创建之后，有 1 个提交改动了与上述 PR 相同的文件，但没有任何编号把它和本 Issue 连起来，值得人工确认是否为静默修复：",
  );
  assert.equal(narrative.hints.length, 1);
  assert.equal(narrative.hints[0].shortSha, "9b93853");
  assert.equal(
    narrative.hints[0].url,
    "https://github.com/facebook/react/commit/9b9385327857d1211fb4dc022122d897fb38bc5a",
  );
});

test("19-B.5 中间结论态（状态三）：标题标记 + 诚实小结行", () => {
  const session = midRunSession({});
  const narrative = buildConclusionNarrative(session);
  assert.ok(narrative);
  assert.equal(narrative.phaseTitle, "结论 · 还没查完，修复未确认");
  assert.equal(narrative.marker, "中间结论 · AI 步数用尽");
  assert.equal(
    narrative.headline,
    "8 步调查预算已用尽，还有 6 个相关 PR 没来得及核对。目前已核对的部分里，PR #37626 仍是最可能的修复，尚未合并。",
  );
  assert.equal(narrative.uncertainty, "下面的结论只基于已核对完的记录，继续调查后可能改变。");
  assert.deepEqual(narrative.whyBullets, []);
  assert.deepEqual(narrative.nextBullets, [
    "继续调查，把剩下 6 个 PR 的内容补齐（见下方「相关修复 PR」小结行）。",
    "Issue 还开着，最可能的修复 PR #37626 也还没合并进主干——这两件事都发生前，没法确认 bug 已修好。",
  ]);
  assert.equal(
    narrative.rowsTag,
    "找到 16 个，已核对 10 个 · 6 个没来得及核对（4 个没能读到内容 · 2 个因数量上限被截断）",
  );
  assert.equal(
    narrative.summaryLine,
    "另有 6 个相关 PR 这次没能读到内容（#37627、#37631 等 4 个 · 2 个因数量上限被截断，编号未知），已记入「证据缺口」，继续调查即可补齐。",
  );
  assert.equal(narrative.rows.length, 10, "只展示有真实信息的行");
  assert.ok(!narrative.rows.some((row) => row.key === "pr-37627"), "读不到内容的候选不逐行占位");
});

test("19-B.6 文案快照扫描：用户可见面板零内部术语", async () => {
  const banned = ["认证条件", "机器裁决", "关闭语义", "Issue 身份", "佐证", "候选", "裁决", "不可能"];
  const session = await replaySession();
  const view = buildInvestigationResultView(session);
  const narrative = view.narrative;
  assert.ok(narrative, "react#37610 重放必须走叙述层");
  const midRun = buildConclusionNarrative(midRunSession({}))!;
  const zeroA = buildConclusionNarrative(zeroClueSession())!;
  const zeroB = buildConclusionNarrative(zeroClueSession({ labels: ["Type: Bug"] }))!;
  for (const block of [narrative, midRun, zeroA, zeroB]) {
    const visible: string[] = [
      block.phaseTitle,
      block.marker ?? "",
      block.headline,
      block.uncertainty,
      block.guidance ?? "",
      block.rowsTag,
      block.summaryLine ?? "",
      block.hintsLead ?? "",
      ...block.whyBullets,
      ...block.nextBullets,
      ...block.rows.flatMap((row) => [row.numberLabel, row.title ?? "", row.statusText ?? "", row.reasonText]),
      ...block.hints.flatMap((hint) => [hint.shortSha, ...hint.files]),
    ];
    for (const text of visible) {
      for (const term of banned) {
        assert.ok(!text.includes(term), `用户可见文案不得包含「${term}」：${text}`);
      }
    }
  }
  // 面板头的计数字符串同样在结论区内。
  const counts = [
    view.verdict.counts.pass > 0 ? `✓ ${view.verdict.counts.pass} 项通过` : "",
    view.verdict.counts.fail > 0 ? `✗ ${view.verdict.counts.fail} 项未通过` : "",
    view.verdict.counts.unknown > 0 ? `? ${view.verdict.counts.unknown} 项待确认` : "",
  ];
  for (const text of counts) {
    for (const term of banned) {
      assert.ok(!text.includes(term));
    }
  }
});

test("19-B.7 分支 A · Issue 信息不足（Status: Unconfirmed）：全部字段模板句", () => {
  const narrative = buildConclusionNarrative(zeroClueSession());
  assert.ok(narrative, "零线索 + 未确认标记必须走分支 A，而不是通用「暂未确认解决」");
  assert.equal(narrative.phaseTitle, "结论 · Issue 信息不足");
  assert.equal(narrative.marker, undefined);
  assert.equal(
    narrative.headline,
    "无法判断是否修复：这条 Issue 的 GitHub 记录里没有留下可核对的修复线索——正文、评论和时间线没有出现任何 PR 编号，官方修复登记里也没有修复它的 PR，仓库还把本 Issue 标记为「Status: Unconfirmed」。这不是调查没做完，而是记录层面根本没有可核对的线索。",
  );
  assert.equal(
    narrative.uncertainty,
    "要回答 bug 还在不在，只能靠实际行为验证（在最新版本上复现），或等信息补全后由维护者跟进。",
  );
  assert.deepEqual(narrative.whyBullets, [
    "机器预扫描通读了 Issue 正文、评论和时间线，逐条提取被引用的 PR 编号：一个都没有找到。",
    "GitHub 的官方修复登记里也没有本 Issue——没有任何已合并 PR 被登记为会修复它。",
    "仓库当前给本 Issue 打的标记是「Status: Unconfirmed」，即这条记录尚待维护者确认。",
    "Issue 至今没人关闭。",
  ]);
  assert.deepEqual(narrative.nextBullets, [
    "补充复现步骤、版本环境和错误信息（或等维护者跟进确认）后，可以重新调查。",
    "要确认 bug 是否还在，最快的办法是在最新版本上直接复现一次。",
  ]);
  assert.equal(narrative.guidance, "🔎 记录层面没有可核对的修复线索 —— 机器预扫描已通读正文、评论与时间线");
  assert.equal(narrative.rows.length, 0);
});

test("19-B.8 分支 B · 零线索但 Issue 有效（无未确认标记）", () => {
  const narrative = buildConclusionNarrative(zeroClueSession({ labels: ["Type: Bug"] }));
  assert.ok(narrative, "无未确认标记的零线索 Issue 走分支 B");
  assert.equal(narrative.phaseTitle, "结论 · 记录里没有修复线索");
  assert.equal(
    narrative.headline,
    "机器核查了正文、评论、时间线和官方修复登记：没有任何 PR 与这条 Issue 产生关联，Issue 至今开放。",
  );
  assert.equal(narrative.uncertainty, "要回答 bug 还在不在，只能靠实际行为验证或等维护者跟进。");
  assert.deepEqual(narrative.whyBullets, [
    "机器预扫描通读了 Issue 正文、评论和时间线，逐条提取被引用的 PR 编号：一个都没有找到。",
    "GitHub 的官方修复登记里也没有本 Issue——没有任何已合并 PR 被登记为会修复它。",
    "Issue 至今没人关闭。",
  ]);
  assert.deepEqual(narrative.nextBullets, [
    "在受影响版本和最新版本各复现一次——这是确认 bug 是否还在的最快途径。",
    "如果怀疑某个 PR 或有新的复现信息，补充到 Issue 评论后可以重新调查。",
  ]);
  assert.equal(narrative.guidance, "🔎 记录层面 0 个关联 PR —— 判断 bug 是否还在需要实际行为验证");

  const closed = buildConclusionNarrative(zeroClueSession({ labels: [], state: "closed" }));
  assert.ok(closed);
  assert.equal(
    closed.headline,
    "机器核查了正文、评论、时间线和官方修复登记：没有任何 PR 与这条 Issue 产生关联，也没有任何 PR 被登记为修复它。",
  );
  assert.ok(!closed.whyBullets.includes("Issue 至今没人关闭。"), "已关闭 Issue 不得声称仍开放");
});

test("19-B.9 空态区块 + Agent 输出默认展开：全部按字段计数判定", () => {
  const zeroView = buildInvestigationResultView(zeroClueSession());
  assert.ok(zeroView.narrative);
  assert.equal(zeroView.narrative.rowsTag, "机器预扫描找到 0 个相关 PR，已全部核对（0 次 AI 调用）");
  assert.equal(zeroView.narrative.summaryLine, "机器预扫描完成：0 条关联线索", "0 候选时区块显示诚实空态，不得整块隐藏");
  assert.equal(zeroView.agentOutputExpanded, true, "零候选 ∧ 无 PR 侧证据 → 默认展开");

  // 反例门：Agent 真读到过 PR 时，既不走零线索分支，也不默认展开。
  const withPr = zeroClueSession();
  withPr.evidence.push({ id: "ev-pr", kind: "pull_request", summary: "获得PR 详情证据", trust: "external_untrusted" });
  assert.equal(buildConclusionNarrative(withPr), undefined);
  assert.equal(buildInvestigationResultView(withPr).agentOutputExpanded, false);

  const midRunView = buildInvestigationResultView(midRunSession({}));
  assert.equal(midRunView.agentOutputExpanded, false, "有已核对记录时维持折叠");
});

test("19-B.10 标签字段搬运：normalizeIssue 原样保留 GitHub 标签名", () => {
  const snapshot = normalizeIssue(
    {
      number: 37269,
      title: "La pantalla se cierra sola",
      body: "",
      state: "open",
      labels: [{ name: "Status: Unconfirmed" }, { name: "" }, "Type: Bug"],
    },
    "facebook",
    "react",
    "2026-09-23T00:00:00Z",
  );
  assert.deepEqual(snapshot.labels, ["Status: Unconfirmed", "Type: Bug"]);
  const legacy = normalizeIssue({ number: 1, title: "", body: "", state: "open" }, "o", "r", "2026-09-23T00:00:00Z");
  assert.equal(legacy.labels, undefined, "无标签字段的老快照保持 undefined，fixtures 真值不动");
});

function candidate(
  overrides: Partial<ResolutionPrescanCandidateDTO> & { pullNumber: number },
): ResolutionPrescanCandidateDTO {
  return { enumeratedBy: ["comment_mention"], detailState: "completed", ...overrides };
}

/**
 * Phase 19-B addendum: #37269-style zero-clue session — completed prescan,
 * 0 enumerated related records, issue/comment/timeline evidence only, and
 * coverage exhausted (machine ran to completion; the records are empty).
 */
function zeroClueSession(
  options: { labels?: string[]; state?: "open" | "closed" } = {},
): InvestigationSessionDTO {
  return {
    mode: "snapshot",
    dataSource: "snapshot",
    actor: "test_driver",
    status: "investigated",
    runStatus: "not_verified",
    task: { owner: "facebook", repository: "react", issueNumber: 37269, description: "investigate" },
    issue: {
      owner: "facebook",
      repository: "react",
      number: 37269,
      title: "La pantalla se cierra sola",
      state: options.state ?? "open",
      createdAt: "2026-08-30T10:00:00Z",
      labels: options.labels ?? ["Status: Unconfirmed"],
    },
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.5,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [],
    },
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #37269 is open", trust: "external_untrusted" },
      { id: "ev-timeline", kind: "timeline", summary: "获得 Issue #37269 Timeline 证据", trust: "external_untrusted" },
    ],
    relations: [],
    claims: [],
    claimEvidence: [],
    steps: [],
    attempts: [],
    report: { conclusion: "", polarity: "unknown", uncertainty: "", openQuestions: [] },
    runtimeBudget: { maxLlmCalls: 8, maxWallClockMs: 60000 },
    resolutionPrescan: {
      state: "completed",
      startedAt: "2026-09-23T00:00:00.000Z",
      completedAt: "2026-09-23T00:00:01.200Z",
      llmCalls: 0 as const,
      candidatesEnumerated: 0,
      candidatesTruncated: false,
      candidates: [],
    },
    attributionCoverage: {
      state: "exhausted",
      prescanState: "completed",
      candidatesEnumerated: 0,
      candidatesAdjudicated: 0,
      unadjudicatedCandidates: [],
      unenumeratedCandidates: 0,
      budgetExhausted: false,
    },
  } satisfies InvestigationSessionDTO;
}

/**
 * Synthetic state-three DTO mirroring the mockup's constructed scenario:
 * 16 enumerated, 10 adjudicated, 4 detail-failed (#37627/#37631 listed),
 * 2 truncated, budget 8/8 used. Plus the 18-B hint line from the live smoke.
 */
function midRunSession(options: { coverage: "off" | null | undefined } = { coverage: undefined }): InvestigationSessionDTO {
  const candidates: ResolutionPrescanCandidateDTO[] = [
    candidate({
      pullNumber: 37626,
      title: "[DOM] Keep Fragment sibling positions stable across renders",
      structuredClosingReference: true,
      merged: false,
      mergedAt: null,
      prCreatedAt: "2026-09-14T10:54:00Z",
    }),
    candidate({ pullNumber: 32722, title: "Add compareDocumentPosition to fragment instances", merged: true, mergedAt: "2025-05-06T00:00:00Z" }),
    candidate({ pullNumber: 34069, title: "Fix fragmentInstance#compareDocumentPosition nesting and portal cases", merged: true, mergedAt: "2025-08-15T00:00:00Z" }),
    candidate({ pullNumber: 37142, title: "[Fragment Refs] Fix DOM/Fiber containment validation", merged: false, mergedAt: null, prCreatedAt: "2026-07-29T00:00:00Z" }),
    candidate({ pullNumber: 37162, title: "[DOM] Find host siblings for nested empty Fragments", merged: true, mergedAt: "2026-08-12T00:00:00Z" }),
    candidate({ pullNumber: 37163, title: "[DOM] Fix Fragment compareDocumentPosition for documentElement and empty portals", merged: true, mergedAt: "2026-08-12T00:00:00Z" }),
    candidate({ pullNumber: 37578, detailState: "not_a_pull_request" }),
    candidate({ pullNumber: 37579, title: "[DOM] Fix Fragment compareDocumentPosition(document) TypeError", merged: true, mergedAt: "2026-09-11T00:00:00Z" }),
    candidate({ pullNumber: 37606, detailState: "not_a_pull_request" }),
    candidate({ pullNumber: 37607, title: "[DOM] Handle non-element portal roots in Fragment document position", merged: false, mergedAt: null, prCreatedAt: "2026-09-11T00:00:00Z" }),
    candidate({ pullNumber: 37627, detailState: "failed", merged: undefined }),
    candidate({ pullNumber: 37631, detailState: "failed", merged: undefined }),
    candidate({ pullNumber: 37633, detailState: "failed", merged: undefined }),
    candidate({ pullNumber: 37635, detailState: "failed", merged: undefined }),
  ];
  const base = {
    mode: "snapshot",
    dataSource: "snapshot",
    actor: "test_driver",
    status: "investigated",
    runStatus: "not_verified",
    task: { owner: "facebook", repository: "react", issueNumber: 37610, description: "investigate" },
    issue: {
      owner: "facebook",
      repository: "react",
      number: 37610,
      title: "FragmentInstance.compareDocumentPosition alternates",
      state: "open",
      createdAt: "2026-09-12T05:58:33Z",
    },
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.5,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [],
    },
    evidence: [],
    relations: [],
    claims: [],
    claimEvidence: [],
    steps: [],
    attempts: [],
    report: { conclusion: "", polarity: "unknown", uncertainty: "", openQuestions: [] },
    runtimeBudget: { maxLlmCalls: 8, maxWallClockMs: 60000 },
    resolutionPrescan: {
      state: "incomplete",
      startedAt: "2026-09-22T00:00:00.000Z",
      completedAt: "2026-09-22T00:00:02.100Z",
      llmCalls: 0 as const,
      candidatesEnumerated: 16,
      candidatesTruncated: true,
      candidates,
      unlinkedFixScan: {
        state: "completed",
        hints: [
          {
            sha: "9b9385327857d1211fb4dc022122d897fb38bc5a",
            files: ["ReactFiberConfigDOM.js", "ReactDOMFragmentRefs-test.js", "ReactFiberTreeReflection.js"],
          },
        ],
        filesExamined: 4,
        filesTruncated: false,
      },
    },
  };
  if (options.coverage === "off") {
    return base satisfies InvestigationSessionDTO;
  }
  return {
    ...base,
    attributionCoverage: {
      state: "mid_run",
      prescanState: "incomplete",
      candidatesEnumerated: 16,
      candidatesAdjudicated: 10,
      unadjudicatedCandidates: [37627, 37631, 37633, 37635],
      unenumeratedCandidates: 2,
      budgetExhausted: true,
    },
  } satisfies InvestigationSessionDTO;
}
