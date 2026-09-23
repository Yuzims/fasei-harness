import type {
  InvestigationSessionDTO,
  ResolutionPrescanCandidateDTO,
} from "@dto";

/**
 * Phase 19-B conclusion narrative. Every sentence is a fixed field-template
 * (dates, PR numbers, merge state booleans, structured closing references).
 * No LLM, no text classification: titles are raw GitHub `title` values
 * rendered verbatim by the components.
 */

export interface CandidateRowView {
  key: string;
  numberLabel: string;
  /** Raw GitHub PR title, verbatim. Undefined when the detail was never fetched. */
  title?: string;
  statusText?: string;
  reasonText: string;
}

export interface UnlinkedHintView {
  sha: string;
  shortSha: string;
  files: string[];
  url?: string;
}

export interface ConclusionNarrativeView {
  phaseTitle: string;
  marker?: string;
  headline: string;
  uncertainty: string;
  whyBullets: string[];
  nextBullets: string[];
  guidance?: string;
  rows: CandidateRowView[];
  rowsTag: string;
  /** Mid-run honest merged summary line replacing unreadable candidate rows. */
  summaryLine?: string;
  hints: UnlinkedHintView[];
  hintsLead?: string;
}

const CN_NUMERALS = ["零", "一", "两", "三", "四", "五", "六", "七", "八", "九", "十"];

/** Evidence kinds that carry PR-side behavioral facts (addendum zero-clue gate). */
export const PR_EVIDENCE_KINDS = ["pull_request", "review", "file", "commit", "code"];

function cnCount(count: number): string {
  return CN_NUMERALS[count] ?? String(count);
}

function isoDay(value?: string | null): string | undefined {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : undefined;
}

function monthDay(value?: string | null): string | undefined {
  const day = isoDay(value);
  if (!day) {
    return undefined;
  }
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return `${month} 月 ${date} 日`;
}

function joinList(items: string[]): string {
  return items.join("、");
}

function isReadable(candidate: ResolutionPrescanCandidateDTO): boolean {
  return candidate.detailState === "completed";
}

function isNonPull(candidate: ResolutionPrescanCandidateDTO): boolean {
  return candidate.detailState === "not_a_pull_request";
}

function rowFor(
  candidate: ResolutionPrescanCandidateDTO,
  issueCreatedAtDay: string | undefined,
): CandidateRowView | undefined {
  const numberLabel = isNonPull(candidate) ? `#${candidate.pullNumber}` : `PR #${candidate.pullNumber}`;
  const base = {
    key: `pr-${candidate.pullNumber}`,
    numberLabel,
    title: candidate.title,
  };
  if (isNonPull(candidate)) {
    return { ...base, reasonText: "GitHub 确认该编号不是 Pull Request，排除" };
  }
  if (!isReadable(candidate)) {
    // Rows without real information merge into the honest summary line (state three rule).
    return undefined;
  }
  const mergedDay = isoDay(candidate.mergedAt);
  if (candidate.merged === true) {
    const statusText = mergedDay ? `已合并 ${mergedDay}` : "已合并";
    if (candidate.structuredClosingReference === true) {
      return {
        ...base,
        statusText,
        reasonText: mergedDay
          ? `官方标记将关闭本 Issue，已于 ${mergedDay} 合并`
          : "官方标记将关闭本 Issue",
      };
    }
    if (mergedDay && issueCreatedAtDay && mergedDay < issueCreatedAtDay) {
      return {
        ...base,
        statusText,
        reasonText: `于 ${mergedDay} 合并，早于本 Issue 提出（${issueCreatedAtDay}），GitHub 记录中也未登记为修复本 Issue`,
      };
    }
    return {
      ...base,
      statusText,
      reasonText: mergedDay
        ? `于 ${mergedDay} 合并进主干，GitHub 记录中未登记为修复本 Issue`
        : "已合并进主干，GitHub 记录中未登记为修复本 Issue",
    };
  }
  const createdDay = isoDay(candidate.prCreatedAt);
  const statusText =
    candidate.merged === false
      ? createdDay
        ? `未合并（${createdDay} 创建）`
        : "未合并"
      : undefined;
  if (candidate.structuredClosingReference === true) {
    return { ...base, statusText, reasonText: "官方标记将关闭本 Issue，目前最可能真正修好它的一个" };
  }
  return { ...base, statusText, reasonText: "与本 Issue 没有官方修复关联，仅作线索" };
}

export function buildConclusionNarrative(
  session: InvestigationSessionDTO,
): ConclusionNarrativeView | undefined {
  const prescan = session.resolutionPrescan;
  const coverage = session.attributionCoverage;
  if (!prescan || !coverage || coverage.state === "not_assertable") {
    return undefined;
  }
  const status = session.verification?.status;
  if (status !== "not_verified" && status !== "insufficient_evidence" && coverage.state !== "mid_run") {
    // 已确认解决等状态沿用既有结论区，本叙述层只覆盖 mockup 的两种未确认形态。
    return undefined;
  }

  const issueDay = isoDay(session.issue.createdAt);
  const issueOpen = (session.issue.state ?? "open").toLowerCase() !== "closed";
  const candidates = prescan.candidates;
  const rows = candidates
    .map((candidate) => rowFor(candidate, issueDay))
    .filter((row): row is CandidateRowView => Boolean(row));

  const closingUnmerged = candidates.filter(
    (candidate) => candidate.structuredClosingReference === true && candidate.merged === false,
  );
  const mergedPreIssue = candidates.filter(
    (candidate) =>
      candidate.merged === true &&
      isoDay(candidate.mergedAt) !== undefined &&
      issueDay !== undefined &&
      (isoDay(candidate.mergedAt) as string) < issueDay &&
      candidate.structuredClosingReference !== true,
  );
  const openUnrelated = candidates.filter(
    (candidate) =>
      isReadable(candidate) &&
      !isNonPull(candidate) &&
      candidate.merged === false &&
      candidate.structuredClosingReference !== true,
  );
  const nonPulls = candidates.filter(isNonPull);
  const best = closingUnmerged[0];

  const midRun = coverage.state === "mid_run";
  const unreadable =
    coverage.unadjudicatedCandidates.length + coverage.unenumeratedCandidates;

  // Phase 19-B addendum: an exhausted prescan with zero related records is a
  // record-level fact, not an unfinished investigation — outrank the generic
  // 「暂未确认解决」 fallback. Field gate only; no text analysis.
  const hasPrEvidence = session.evidence.some((item) => PR_EVIDENCE_KINDS.includes(item.kind));
  if (coverage.state === "exhausted" && candidates.length === 0 && !hasPrEvidence) {
    return buildZeroClueNarrative(session, issueOpen);
  }

  const headline = midRun
    ? buildMidRunHeadline(session, coverage.unadjudicatedCandidates, coverage.unenumeratedCandidates, best)
    : buildExhaustedHeadline(best, issueOpen);
  if (!headline) {
    return undefined;
  }

  const whyBullets: string[] = [];
  if (!midRun) {
    if (closingUnmerged.length > 0) {
      const list = joinList(
        closingUnmerged.map((candidate) => {
          const label = `PR #${candidate.pullNumber}`;
          return candidate.title ? `${label}（${candidate.title}）` : label;
        }),
      );
      const pronoun = closingUnmerged.length === 1 ? "它" : "它们";
      whyBullets.push(
        `GitHub 官方记录里，只有 ${list}被标记为修复本 Issue，但${pronoun}还在等待评审合并。`,
      );
    }
    if (mergedPreIssue.length > 0 && issueDay) {
      whyBullets.push(
        `其余已合并的相关 PR（${joinList(mergedPreIssue.map((c) => `#${c.pullNumber}`))}）全部在本 Issue 提出之前合并，GitHub 记录里也都没有登记为修复本 Issue。也不排除其中某个 PR 已修复主干上的问题而报告者所用版本较旧——确认需要核对版本发版时间，目前证据里没有。`,
      );
    }
    const parts: string[] = [];
    if (openUnrelated.length > 0) {
      parts.push(
        `另有 ${openUnrelated.length} 个未合并的 PR（${joinList(openUnrelated.map((c) => `#${c.pullNumber}`))}）与本 Issue 没有官方关联，只能作为线索`,
      );
    }
    if (nonPulls.length > 0) {
      parts.push(`${joinList(nonPulls.map((c) => `#${c.pullNumber}`))} ${cnCount(nonPulls.length)}个编号不是 PR`);
    }
    if (parts.length > 0) {
      whyBullets.push(`${parts.join("；")}。`);
    }
    if (issueOpen) {
      whyBullets.push("Issue 至今没人关闭。");
    }
  }

  const nextBullets: string[] = [];
  if (midRun) {
    nextBullets.push(
      `继续调查，把剩下 ${unreadable} 个 PR 的内容补齐（见下方「相关修复 PR」小结行）。`,
    );
    if (issueOpen && best) {
      nextBullets.push(
        `Issue 还开着，最可能的修复 PR #${best.pullNumber} 也还没合并进主干——这两件事都发生前，没法确认 bug 已修好。`,
      );
    }
  } else {
    if (best && issueOpen) {
      nextBullets.push(
        `等 #${best.pullNumber} 通过评审、合并进主干，维护者关闭 Issue，结论就会变成「已解决」。`,
      );
    }
    if (best) {
      // 固定尾句模板：merged===false ∧ structuredClosingReference===true 时输出。
      nextBullets.push(`如果急需可用的修复，可以先试装 #${best.pullNumber} 的分支验证效果。`);
    }
  }

  const rowsTag = midRun
    ? `找到 ${prescan.candidatesEnumerated} 个，已核对 ${coverage.candidatesAdjudicated} 个 · ${unreadable} 个没来得及核对（${coverage.unadjudicatedCandidates.length} 个没能读到内容${coverage.unenumeratedCandidates > 0 ? ` · ${coverage.unenumeratedCandidates} 个因数量上限被截断` : ""}）`
    : `机器预扫描找到 ${prescan.candidatesEnumerated} 个，已全部核对（0 次 AI 调用）· 排序：官方标记修复本 Issue 的排最前`;

  const summaryLine = midRun
    ? buildSummaryLine(coverage.unadjudicatedCandidates, coverage.unenumeratedCandidates)
    : undefined;

  const hintsSource = prescan.unlinkedFixScan?.hints ?? [];
  const repo = `${session.issue.owner}/${session.issue.repository}`;
  const hints: UnlinkedHintView[] = hintsSource.map((hint) => ({
    sha: hint.sha,
    shortSha: hint.sha.slice(0, 7),
    files: hint.files,
    url: `https://github.com/${repo}/commit/${hint.sha}`,
  }));
  const hintsLead =
    hints.length > 0
      ? `在主干分支上、本 Issue 创建之后，有 ${hints.length} 个提交改动了与上述 PR 相同的文件，但没有任何编号把它和本 Issue 连起来，值得人工确认是否为静默修复：`
      : undefined;

  return {
    phaseTitle: midRun ? "结论 · 还没查完，修复未确认" : "结论 · 修复还没完成",
    marker: midRun
      ? coverage.budgetExhausted
        ? "中间结论 · AI 步数用尽"
        : "中间结论 · 还没查完"
      : undefined,
    headline,
    uncertainty: midRun
      ? "下面的结论只基于已核对完的记录，继续调查后可能改变。"
      : "但也不能断定 bug 还在：修复可能已经生效，只是 GitHub 记录上没走完——最终以维护者关闭 Issue 或实际行为验证为准。",
    whyBullets,
    nextBullets,
    guidance: best
      ? midRun
        ? undefined
        : `🔎 最接近修好的：PR #${best.pullNumber}（官方标记将关闭本 Issue，尚未合并）—— ${prescan.candidatesEnumerated} 个相关 PR 已全部核对`
      : undefined,
    rows,
    rowsTag,
    summaryLine,
    hints,
    hintsLead,
  };
}

const ZERO_CLUE_ROWS_TAG = "机器预扫描找到 0 个相关 PR，已全部核对（0 次 AI 调用）";
const ZERO_CLUE_SUMMARY_LINE = "机器预扫描完成：0 条关联线索";

function findUnconfirmedLabel(labels: string[] | undefined): string | undefined {
  return labels?.find((label) => /unconfirmed/i.test(label) || label.includes("待确认"));
}

/**
 * Phase 19-B addendum branches A/B: exhausted prescan, zero related records.
 * Branch A (「Issue 信息不足」) additionally requires an unconfirmed marker in the
 * verbatim GitHub label list; B covers valid-but-unlinked issues. Grounded
 * clauses only: 0 enumerated ∧ 0 closing registrations ∧ label/state fields.
 */
function buildZeroClueNarrative(
  session: InvestigationSessionDTO,
  issueOpen: boolean,
): ConclusionNarrativeView {
  const unconfirmedLabel = findUnconfirmedLabel(session.issue.labels);
  const base = {
    marker: undefined,
    rows: [] as CandidateRowView[],
    rowsTag: ZERO_CLUE_ROWS_TAG,
    summaryLine: ZERO_CLUE_SUMMARY_LINE,
    hints: [] as UnlinkedHintView[],
    hintsLead: undefined,
  };
  const readThrough = "机器预扫描通读了 Issue 正文、评论和时间线，逐条提取被引用的 PR 编号：一个都没有找到。";
  const noClosing = "GitHub 的官方修复登记里也没有本 Issue——没有任何已合并 PR 被登记为会修复它。";
  const stillOpen = issueOpen ? ["Issue 至今没人关闭。"] : [];
  if (unconfirmedLabel) {
    return {
      ...base,
      phaseTitle: "结论 · Issue 信息不足",
      headline: `无法判断是否修复：这条 Issue 的 GitHub 记录里没有留下可核对的修复线索——正文、评论和时间线没有出现任何 PR 编号，官方修复登记里也没有修复它的 PR，仓库还把本 Issue 标记为「${unconfirmedLabel}」。这不是调查没做完，而是记录层面根本没有可核对的线索。`,
      uncertainty: "要回答 bug 还在不在，只能靠实际行为验证（在最新版本上复现），或等信息补全后由维护者跟进。",
      whyBullets: [
        readThrough,
        noClosing,
        `仓库当前给本 Issue 打的标记是「${unconfirmedLabel}」，即这条记录尚待维护者确认。`,
        ...stillOpen,
      ],
      nextBullets: [
        "补充复现步骤、版本环境和错误信息（或等维护者跟进确认）后，可以重新调查。",
        "要确认 bug 是否还在，最快的办法是在最新版本上直接复现一次。",
      ],
      guidance: "🔎 记录层面没有可核对的修复线索 —— 机器预扫描已通读正文、评论与时间线",
    };
  }
  return {
    ...base,
    phaseTitle: "结论 · 记录里没有修复线索",
    headline: `机器核查了正文、评论、时间线和官方修复登记：没有任何 PR 与这条 Issue 产生关联${issueOpen ? "，Issue 至今开放。" : "，也没有任何 PR 被登记为修复它。"}`,
    uncertainty: "要回答 bug 还在不在，只能靠实际行为验证或等维护者跟进。",
    whyBullets: [readThrough, noClosing, ...stillOpen],
    nextBullets: [
      "在受影响版本和最新版本各复现一次——这是确认 bug 是否还在的最快途径。",
      "如果怀疑某个 PR 或有新的复现信息，补充到 Issue 评论后可以重新调查。",
    ],
    guidance: "🔎 记录层面 0 个关联 PR —— 判断 bug 是否还在需要实际行为验证",
  };
}

function buildExhaustedHeadline(
  best: ResolutionPrescanCandidateDTO | undefined,
  issueOpen: boolean,
): string | undefined {
  if (!best) {
    return undefined;
  }
  const submitted = monthDay(best.prCreatedAt);
  return `官方修复 PR #${best.pullNumber} ${submitted ? `已于 ${submitted}提交，` : ""}至今未合并进主干${issueOpen ? "，Issue 也仍挂着。" : "。"}`;
}

function buildMidRunHeadline(
  session: InvestigationSessionDTO,
  unadjudicated: number[],
  unenumerated: number,
  best: ResolutionPrescanCandidateDTO | undefined,
): string | undefined {
  const remaining = unadjudicated.length + unenumerated;
  if (remaining === 0) {
    return undefined;
  }
  const budget = session.runtimeBudget?.maxLlmCalls;
  const lead = budget
    ? `${budget} 步调查预算已用尽，还有 ${remaining} 个相关 PR 没来得及核对。`
    : `还有 ${remaining} 个相关 PR 没来得及核对。`;
  return best
    ? `${lead}目前已核对的部分里，PR #${best.pullNumber} 仍是最可能的修复，尚未合并。`
    : `${lead}目前已核对的部分里，还没有出现官方登记的修复。`;
}

function buildSummaryLine(unadjudicated: number[], unenumerated: number): string | undefined {
  const total = unadjudicated.length + unenumerated;
  if (total === 0) {
    return undefined;
  }
  const listed = unadjudicated.slice(0, 2).map((n) => `#${n}`);
  const detailPart =
    unadjudicated.length > 0
      ? listed.length > 0
        ? `${joinList(listed)} 等 ${unadjudicated.length} 个`
        : `${unadjudicated.length} 个`
      : undefined;
  const truncPart = unenumerated > 0 ? `${unenumerated} 个因数量上限被截断，编号未知` : undefined;
  const parts = [detailPart, truncPart].filter(Boolean).join(" · ");
  return `另有 ${total} 个相关 PR 这次没能读到内容（${parts}），已记入「证据缺口」，继续调查即可补齐。`;
}
