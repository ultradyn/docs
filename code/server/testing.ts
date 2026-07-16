/**
 * Explicit test-only surface for deterministic server internals.
 * Production code must import from `server/index.ts` instead.
 */
export {
  CriticOutputSchema,
  DiffSummarizerOutputSchema,
  LibrarianOutputSchema,
  StructurerOutputSchema,
  criticEvaluation,
  renderStructuredAnswer,
} from "./agent-workflow.js";
export { MaintenanceCoordinator } from "./maintenance-coordinator.js";
export type { MaintenanceCoordinatorOptions } from "./maintenance-coordinator.js";
export { MaintenanceScheduler } from "./maintenance.js";
export type { MaintenanceSchedulerOptions } from "./maintenance.js";
export { bestQuestionMatch } from "./question-matcher.js";
export { DocumentationIndex } from "./retrieval.js";
export type {
  DocumentationContextEntry,
  DocumentationMatch,
} from "./retrieval.js";
export { browserUrlHostname } from "./start.js";
