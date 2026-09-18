import type { BenchmarkFailureMode, BenchmarkScenario, ExpectedOutcome, ObservedOutcome } from "./types.js";

/**
 * Expected observed production failures.
 * `scenario.failureMode` is experiment intent and must not fill this in.
 */
export function expectedFailureModes(scenario: BenchmarkScenario): BenchmarkFailureMode[] {
  return scenario.expectedOutcome?.failureModes ?? [];
}

export function compareFailureModes(
  expected: readonly BenchmarkFailureMode[],
  observed: readonly string[],
): boolean {
  return expected.every((mode) => observed.includes(mode));
}

export function compareRecovery(
  required: boolean | undefined,
  observed: Pick<ObservedOutcome, "recoveryAttempted" | "recovered">,
): boolean {
  if (required !== true) {
    return true;
  }
  return observed.recoveryAttempted || observed.recovered;
}

/**
 * Compare an evaluator expected-outcome contract to observed Harness results.
 * Does not re-run verification, failure analysis, or recovery planning.
 */
export function evaluateExpectedContract(
  expected: ExpectedOutcome,
  observed: ObservedOutcome,
): {
  passed: boolean;
  verificationPassed: boolean;
  failureModesPassed: boolean;
  recoveryPassed: boolean;
} {
  const expectedModes = expected.failureModes ?? [];
  const verificationPassed = expected.verificationStatus === observed.verificationStatus;
  const failureModesPassed = compareFailureModes(expectedModes, observed.failureTypes);
  const recoveryPassed = compareRecovery(expected.recovery?.required, observed);
  return {
    passed: verificationPassed && failureModesPassed && recoveryPassed,
    verificationPassed,
    failureModesPassed,
    recoveryPassed,
  };
}

/**
 * Compare scenario contract to observed Harness results.
 * Does not re-run verification, failure analysis, or recovery planning.
 */
export function evaluateScenarioContract(
  scenario: BenchmarkScenario,
  observed: ObservedOutcome,
): {
  passed: boolean;
  verificationPassed: boolean;
  failureModesPassed: boolean;
  recoveryPassed: boolean;
} {
  if (!scenario.expectedOutcome) {
    throw new Error(
      `scenario ${scenario.id} is missing expectedOutcome; load ground-truth.json for real dataset evaluation`,
    );
  }
  return evaluateExpectedContract(scenario.expectedOutcome, observed);
}
