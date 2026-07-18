/**
 * Repository-only deterministic implementation seams for tests.
 * Production code must import ./index.js instead.
 */
export {
  createTestingFileCoverageObligationEventWriter,
  type TestingCoverageObligationEventWriterHooks,
} from "./coverage-obligation-event-writer-implementation.js";
