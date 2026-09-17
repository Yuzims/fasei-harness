import type { BenchmarkFailureMode, BenchmarkScenario, ObservedOutcome } from "./types.js";

export function expectedFailureModes(scenario: BenchmarkScenario): BenchmarkFailureMode[] {
  if (scenario.expectedOutcome.failureModes && scenario.expectedOutcome.failureModes.length > 0) {
    return scenario.expectedOutcome.failureModes;
  }
  return scenario.failureMode ? [scenario.failureMode] : [];
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
  const expectedModes = expectedFailureModes(scenario);
  const verificationPassed =
    scenario.expectedOutcome.verificationStatus === observed.verificationStatus;
  const failureModesPassed = compareFailureModes(expectedModes, observed.failureTypes);
  const recoveryPassed = compareRecovery(scenario.expectedOutcome.recovery?.required, observed);
  return {
    passed: verificationPassed && failureModesPassed && recoveryPassed,
    verificationPassed,
    failureModesPassed,
    recoveryPassed,
  };
}
