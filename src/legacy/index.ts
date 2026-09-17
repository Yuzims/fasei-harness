/**
 * Legacy workspace failure injection.
 *
 * Legacy Failure Injection ≠ Investigation Recovery
 *
 * Product path: src/domain + src/investigation (FailureEvent → RecoveryPlan → applyRecovery).
 * This module only serves the synthetic workspace Harness / benchmark / workbench demos.
 */
export type { Failure, FailureType } from "./failure/failure-types.js";
export { FailureAnalyzer } from "./failure/failure-analyzer.js";
export {
  RecoveryPlanner,
  type Planner,
  type RecoveryAction,
  type RecoveryPlan,
} from "./recovery/recovery-planner.js";
