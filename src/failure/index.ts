/**
 * Phase 14.3 Failure Localization + Phase 14.4 Failure Reporting layer.
 *
 * VerificationResult → FailureClassifier → FailureEvent → failure_localized trace event.
 * FailureEvent[] → FailureReportBuilder → FailureReport.
 * This layer explains WHY verification failed. It never decides HOW to recover,
 * never modifies the completion verdict, and never touches recovery, evidence,
 * or tool layers.
 */
export * from "./failure-types.js";
export * from "./failure-factory.js";
export * from "./failure-classifier.js";
export * from "./report/failure-report-types.js";
export * from "./report/failure-report-builder.js";
