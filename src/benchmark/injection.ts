/**
 * Deterministic failure injection at the benchmark boundary.
 *
 * Wraps GitHubDataProvider and/or supplies a test Model.
 * Production FailureAnalyzer / RecoveryPlanner / Verifier are unchanged.
 */
import { randomUUID } from "node:crypto";
import type { Model, ModelResponse } from "../agent/model.js";
import { GitHubProviderError } from "../github/errors.js";
import type { GitHubDataProvider } from "../github/provider.js";
import { SnapshotGitHubProvider } from "../github/snapshot-provider.js";
import type { IssueRef } from "../github/types.js";
import type { InvestigateOptions, InvestigationSession } from "../investigation/index.js";
import { SnapshotInvestigationDriver } from "../investigation/index.js";
import { resourceKey } from "../investigation/state.js";
import type { BenchmarkFailureMode, BenchmarkScenario } from "./types.js";

export interface ScenarioEnvironment {
  provider: GitHubDataProvider;
  useTestDriver: boolean;
  modelFactory?: InvestigateOptions["modelFactory"];
}

function targetArgs(session: InvestigationSession) {
  return {
    owner: session.state.task.target.owner,
    repo: session.state.task.target.repository,
    issueNumber: session.state.task.target.issueNumber,
  };
}

function issueKey(session: InvestigationSession): string {
  return resourceKey("issue", String(session.state.task.target.issueNumber));
}

function issueNotObserved(session: InvestigationSession): boolean {
  return !session.state.investigatedResources.has(issueKey(session));
}

function callGetIssue(session: InvestigationSession, reason: string): ModelResponse {
  session.state.pendingReason = reason;
  return {
    type: "tool_call",
    call: {
      id: randomUUID(),
      name: "github_get_issue",
      arguments: targetArgs(session),
    },
  };
}

function firstAttemptThenDriver(session: InvestigationSession, first: Model): Model {
  const driver = new SnapshotInvestigationDriver(session.state);
  return {
    async decide(task, history, toolResults, context) {
      if ((context?.attempt ?? 1) > 1) {
        return driver.decide(task, history, toolResults, context);
      }
      return first.decide(task, history, toolResults, context);
    },
  };
}

function wrapIssueRefs(inner: GitHubDataProvider, issueNumber: number): GitHubDataProvider {
  const remap = (ref: IssueRef): IssueRef => ({ ...ref, issueNumber });
  return {
    getRepository: (ref) => inner.getRepository(ref),
    getIssue: (ref) => inner.getIssue(remap(ref)),
    getIssueComments: (ref) => inner.getIssueComments(remap(ref)),
    getIssueTimeline: (ref) => inner.getIssueTimeline(remap(ref)),
    getPullRequest: (ref) => inner.getPullRequest(ref),
    getPullRequestReviews: (ref) => inner.getPullRequestReviews(ref),
    getPullRequestFiles: (ref) => inner.getPullRequestFiles(ref),
    listCommits: (query) => inner.listCommits(query),
    getCommit: (ref) => inner.getCommit(ref),
    searchRepositories: (query) => inner.searchRepositories(query),
    getReadme: (ref) => inner.getReadme(ref),
  };
}

function wrapToolTimeout(inner: GitHubDataProvider): GitHubDataProvider {
  let issueCalls = 0;
  return {
    getRepository: (ref) => inner.getRepository(ref),
    getIssue: async (ref) => {
      issueCalls += 1;
      if (issueCalls === 1) {
        throw new GitHubProviderError({
          code: "timeout",
          operation: "getIssue",
          message: "injected timeout for benchmark tool_failure",
        });
      }
      return inner.getIssue(ref);
    },
    getIssueComments: (ref) => inner.getIssueComments(ref),
    getIssueTimeline: (ref) => inner.getIssueTimeline(ref),
    getPullRequest: (ref) => inner.getPullRequest(ref),
    getPullRequestReviews: (ref) => inner.getPullRequestReviews(ref),
    getPullRequestFiles: (ref) => inner.getPullRequestFiles(ref),
    listCommits: (query) => inner.listCommits(query),
    getCommit: (ref) => inner.getCommit(ref),
    searchRepositories: (query) => inner.searchRepositories(query),
    getReadme: (ref) => inner.getReadme(ref),
  };
}

function wrapInvalidIssue(inner: GitHubDataProvider): GitHubDataProvider {
  return {
    getRepository: (ref) => inner.getRepository(ref),
    getIssue: async (ref) => {
      const issue = await inner.getIssue(ref);
      return { ...issue, number: 0 };
    },
    getIssueComments: (ref) => inner.getIssueComments(ref),
    getIssueTimeline: (ref) => inner.getIssueTimeline(ref),
    getPullRequest: (ref) => inner.getPullRequest(ref),
    getPullRequestReviews: (ref) => inner.getPullRequestReviews(ref),
    getPullRequestFiles: (ref) => inner.getPullRequestFiles(ref),
    listCommits: (query) => inner.listCommits(query),
    getCommit: (ref) => inner.getCommit(ref),
    searchRepositories: (query) => inner.searchRepositories(query),
    getReadme: (ref) => inner.getReadme(ref),
  };
}

function snapshotIssueNumber(provider: GitHubDataProvider): number | undefined {
  if (provider instanceof SnapshotGitHubProvider) {
    return provider.getSnapshot().issueNumber;
  }
  return undefined;
}

function modelFor(mode: BenchmarkFailureMode, session: InvestigationSession): Model {
  if (mode === "tool_failure") {
    return firstAttemptThenDriver(session, {
      async decide(_task, _history, toolResults) {
        if (toolResults.some((item) => item.success === false)) {
          return { type: "final", message: "Tool failed; stopping this attempt. Not verified." };
        }
        if (toolResults.length === 0 || issueNotObserved(session)) {
          return callGetIssue(session, "Observe the issue first.");
        }
        return { type: "final", message: "Observed the issue. Not verified." };
      },
    });
  }

  if (mode === "premature_completion") {
    return firstAttemptThenDriver(session, {
      async decide() {
        if (issueNotObserved(session)) {
          return callGetIssue(session, "Observe the issue first.");
        }
        if (!session.state.claimsRecorded) {
          session.state.pendingReason = "Claim resolved without sufficient evidence.";
          return {
            type: "tool_call",
            call: {
              id: randomUUID(),
              name: "record_claim",
              arguments: {
                claims: [
                  {
                    text: `Issue #${session.state.task.target.issueNumber} is resolved.`,
                    polarity: "resolved",
                    critical: true,
                    evidenceIds: session.state.run.evidence.map((item) => item.id),
                    role: "supports",
                  },
                ],
                conclusion: "Resolved.",
                polarity: "resolved",
              },
            },
          };
        }
        return { type: "final", message: "Done. Issue is resolved." };
      },
    });
  }

  if (mode === "retrieval_failure") {
    return firstAttemptThenDriver(session, {
      async decide() {
        if (issueNotObserved(session)) {
          return callGetIssue(session, "First retrieval only.");
        }
        return { type: "final", message: "Stopped after the first retrieval. Not verified." };
      },
    });
  }

  if (mode === "loop_failure") {
    return {
      async decide() {
        const repeats = session.state.toolHistory.filter((item) => item.tool === "github_get_issue").length;
        if (repeats >= 4) {
          return { type: "final", message: "Repeating the same tool. Not verified." };
        }
        return callGetIssue(session, "Repeat the same issue fetch.");
      },
    };
  }

  if (mode === "invalid_evidence") {
    return {
      async decide() {
        if (issueNotObserved(session)) {
          return callGetIssue(session, "Observe the issue first.");
        }
        return { type: "final", message: "Recorded the issue observation. Not verified." };
      },
    };
  }

  return new SnapshotInvestigationDriver(session.state);
}

export function prepareScenarioEnvironment(
  scenario: BenchmarkScenario,
  inner: GitHubDataProvider,
): ScenarioEnvironment {
  const mode = scenario.kind === "failure" ? scenario.failureMode : undefined;
  if (!mode) {
    return { provider: inner, useTestDriver: true };
  }

  if (mode === "tool_failure") {
    return {
      provider: wrapToolTimeout(inner),
      useTestDriver: false,
      modelFactory: (session) => modelFor("tool_failure", session),
    };
  }

  if (mode === "wrong_target") {
    const actual = snapshotIssueNumber(inner);
    return {
      provider: actual !== undefined ? wrapIssueRefs(inner, actual) : inner,
      useTestDriver: true,
    };
  }

  if (mode === "invalid_evidence") {
    return {
      provider: wrapInvalidIssue(inner),
      useTestDriver: false,
      modelFactory: (session) => modelFor("invalid_evidence", session),
    };
  }

  if (mode === "premature_completion" || mode === "retrieval_failure" || mode === "loop_failure") {
    return {
      provider: inner,
      useTestDriver: false,
      modelFactory: (session) => modelFor(mode, session),
    };
  }

  return { provider: inner, useTestDriver: true };
}
