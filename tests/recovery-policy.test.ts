import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createInvestigationRun,
  createInvestigationTask,
  type ResolutionGap,
  type ResolutionGapType,
} from "../src/domain/index.js";
import {
  DEFAULT_RECOVERY_ACTION_PROFILES,
  IndependentCompletionVerifier,
  RECOVERY_POLICY_EVENT_TYPE,
  RECOVERY_POLICY_NOTICE,
  createRecoveryActionProfile,
  createRecoveryBudget,
  createRecoveryExecutor,
  decideRecoveryPolicy,
  deriveRecoveryIntents,
  recordRecoveryPolicyDecision,
  remainingPolicyBudget,
  toRecoveryActionCandidatesFromIntents,
  toRecoveryPolicyDecisionEvent,
  type RecoveryActionCandidate,
  type RecoveryActionProfile,
  type RecoveryPolicyInput,
} from "../src/investigation/index.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_DIR = join(ROOT, "src", "investigation", "recovery", "policy");

function gap(type: ResolutionGapType, severity: ResolutionGap["severity"] = "blocking"): ResolutionGap {
  return {
    candidateId: "cand-1",
    type,
    severity,
    missingEvidenceTypes: [],
    evidenceIds: ["ev-1"],
    explanation: "synthetic gap",
    recommendedActions: [],
  };
}

function candidate(action: string, intentId = "synthetic"): RecoveryActionCandidate {
  return {
    action: action as RecoveryActionCandidate["action"],
    reason: `Candidate ${action}`,
    intentId,
    autoExecute: false,
  };
}

function policyInput(partial: Partial<RecoveryPolicyInput> & Pick<RecoveryPolicyInput, "gaps">): RecoveryPolicyInput {
  const intents = partial.intents ?? deriveRecoveryIntents(partial.gaps);
  return {
    gaps: partial.gaps,
    intents,
    candidates: partial.candidates ?? toRecoveryActionCandidatesFromIntents(intents),
    budget: partial.budget ?? createRecoveryBudget(),
    actionProfiles: partial.actionProfiles ?? DEFAULT_RECOVERY_ACTION_PROFILES.map(createRecoveryActionProfile),
  };
}

function fingerprint(result: { status: string; checks: Array<{ id: string; status: string }> }) {
  return `${result.status}|${result.checks.map((item) => `${item.id}:${item.status}`).join("|")}`;
}

test("Test 1: Policy deterministic", () => {
  const input = policyInput({
    gaps: [gap("missing_patch_evidence"), gap("missing_validation_evidence", "warning")],
  });
  const first = decideRecoveryPolicy(input);
  const second = decideRecoveryPolicy(input);
  assert.deepEqual(second, first);
  assert.deepEqual(decideRecoveryPolicy(input), first);
  assert.match(RECOVERY_POLICY_NOTICE, /not learning/i);
  assert.equal("winner" in first, false);
});

test("Test 2: Budget constraint works", () => {
  const expensive: RecoveryActionProfile = {
    action: "fetch_commit_patch",
    estimatedCost: 5,
    resolvesGapTypes: ["missing_patch_evidence"],
  };
  const cheap: RecoveryActionProfile = {
    action: "inspect_changed_files",
    estimatedCost: 1,
    resolvesGapTypes: ["missing_patch_evidence"],
  };
  const budget = createRecoveryBudget({ maxRecoveryRounds: 1, maxAdditionalActions: 2, maxAdditionalToolCalls: 4 });
  assert.equal(remainingPolicyBudget(budget), 2);
  const decision = decideRecoveryPolicy(
    policyInput({
      gaps: [gap("missing_patch_evidence")],
      candidates: [candidate("fetch_commit_patch"), candidate("inspect_changed_files")],
      budget,
      actionProfiles: [expensive, cheap],
    }),
  );
  assert.deepEqual(decision.selectedActions, ["inspect_changed_files"]);
  assert.equal(decision.rejectedActions.includes("fetch_commit_patch"), true);
  assert.match(decision.reason, /over_budget/);
});

test("Test 3: Blocking gap priority", () => {
  const decision = decideRecoveryPolicy(
    policyInput({
      gaps: [gap("missing_patch_evidence", "blocking"), gap("missing_validation_evidence", "warning")],
      candidates: [candidate("search_regression_tests"), candidate("fetch_commit_patch")],
      budget: createRecoveryBudget({ maxAdditionalActions: 2, maxAdditionalToolCalls: 4 }),
      actionProfiles: [
        {
          action: "search_regression_tests",
          estimatedCost: 1,
          resolvesGapTypes: ["missing_validation_evidence"],
        },
        {
          action: "fetch_commit_patch",
          estimatedCost: 2,
          resolvesGapTypes: ["missing_patch_evidence"],
        },
      ],
    }),
  );
  assert.deepEqual(decision.selectedActions, ["fetch_commit_patch"]);
  assert.equal(decision.rejectedActions.includes("search_regression_tests"), true);
  assert.equal(decision.selectedActions[0], "fetch_commit_patch");
});

test("Test 4: Lower cost wins when coverage equal", () => {
  const decision = decideRecoveryPolicy(
    policyInput({
      gaps: [gap("missing_patch_evidence")],
      candidates: [candidate("fetch_commit_patch"), candidate("inspect_changed_files")],
      budget: createRecoveryBudget({ maxAdditionalActions: 10, maxAdditionalToolCalls: 10 }),
      actionProfiles: [
        {
          action: "fetch_commit_patch",
          estimatedCost: 5,
          resolvesGapTypes: ["missing_patch_evidence"],
        },
        {
          action: "inspect_changed_files",
          estimatedCost: 2,
          resolvesGapTypes: ["missing_patch_evidence"],
        },
      ],
    }),
  );
  assert.deepEqual(decision.selectedActions, ["inspect_changed_files"]);
  assert.equal(decision.rejectedActions.includes("fetch_commit_patch"), true);
  assert.match(decision.reason, /redundant|inspect_changed_files/);
});

test("Test 5: Policy does not execute recovery", () => {
  let executed = 0;
  const executor = createRecoveryExecutor(async () => {
    executed += 1;
    return { action: "fetch_commit_patch", addedEvidenceIds: ["ev-new"], status: "completed" };
  });
  const input = policyInput({ gaps: [gap("missing_patch_evidence")] });
  Object.freeze(input.gaps);
  Object.freeze(input.candidates);
  Object.freeze(input.intents);
  Object.freeze(input.actionProfiles);
  const decision = decideRecoveryPolicy(input);
  assert.equal(executed, 0);
  assert.equal(typeof executor.execute, "function");
  assert.equal("addedEvidenceIds" in decision, false);
  assert.equal("status" in decision, false);
  assert.equal("execution" in decision, false);
  assert.equal(decision.selectedActions.includes("fetch_commit_patch"), true);
  const encoded = JSON.stringify(decision);
  assert.equal(/addedEvidenceIds|tool_call|github_get_/.test(encoded), false);
});

test("Test 6: Policy does not modify verifier state", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const run = createInvestigationRun({ task });
  const verifier = new IndependentCompletionVerifier();
  const before = verifier.verify({ task, run });
  decideRecoveryPolicy(policyInput({ gaps: [gap("missing_patch_evidence"), gap("missing_candidate")] }));
  const after = verifier.verify({ task, run });
  assert.equal(fingerprint(after), fingerprint(before));
  assert.equal(run.evidence.length, 0);
});

test("trace records Recovery Policy decisions only", () => {
  const input = policyInput({ gaps: [gap("missing_patch_evidence")] });
  const decision = decideRecoveryPolicy(input);
  const payload = toRecoveryPolicyDecisionEvent(input, decision);
  const trace = new TraceCollector();
  recordRecoveryPolicyDecision(trace, "run-policy", 0, payload);
  const recorded = trace.getEvents();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.type, RECOVERY_POLICY_EVENT_TYPE);
  assert.deepEqual(recorded[0]?.data, {
    gapTypes: payload.gapTypes,
    candidateActions: payload.candidateActions,
    selectedActions: payload.selectedActions,
    rejectedActions: payload.rejectedActions,
    reason: payload.reason,
  });
  assert.equal("result" in (recorded[0]?.data ?? {}), false);
  assert.equal("addedEvidenceIds" in (recorded[0]?.data ?? {}), false);
  assert.equal("success" in (recorded[0]?.data ?? {}), false);
});

test("Policy layer does not import executor, loop, verifier, or GitHub", () => {
  for (const file of readdirSync(POLICY_DIR)) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(join(POLICY_DIR, file), "utf8");
    assert.equal(/from ["'][^"']*recovery-executor/.test(source), false, file);
    assert.equal(/from ["'][^"']*controlled-recovery-loop/.test(source), false, file);
    assert.equal(/from ["'][^"']*independent-completion-verifier/.test(source), false, file);
    assert.equal(/from ["'][^"']*github/.test(source), false, file);
    assert.equal(/from ["'][^"']*agent-loop/.test(source), false, file);
    assert.equal(/from ["'][^"']*recovery-planner/.test(source), false, file);
  }
});

test("stable ordering keeps original candidate order on a tie", () => {
  const decision = decideRecoveryPolicy(
    policyInput({
      gaps: [gap("missing_patch_evidence")],
      candidates: [candidate("inspect_changed_files"), candidate("fetch_commit_patch")],
      budget: createRecoveryBudget({ maxAdditionalActions: 10, maxAdditionalToolCalls: 10 }),
      actionProfiles: [
        {
          action: "inspect_changed_files",
          estimatedCost: 2,
          resolvesGapTypes: ["missing_patch_evidence"],
        },
        {
          action: "fetch_commit_patch",
          estimatedCost: 2,
          resolvesGapTypes: ["missing_patch_evidence"],
        },
      ],
    }),
  );
  assert.deepEqual(decision.selectedActions, ["inspect_changed_files"]);
});
