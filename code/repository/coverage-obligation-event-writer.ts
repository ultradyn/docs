import type { CoverageObligationEventWriter } from "../domain/ingest/index.js";
import {
  createFileCoverageObligationEventWriterImplementation,
  type FileCoverageObligationEventWriterOptions,
} from "./coverage-obligation-event-writer-implementation.js";

export type { FileCoverageObligationEventWriterOptions };

/** Production factory: accepts only repository-lock dependencies. */
export function createFileCoverageObligationEventWriter(
  root: string,
  options: FileCoverageObligationEventWriterOptions = {},
): CoverageObligationEventWriter {
  return createFileCoverageObligationEventWriterImplementation(root, options);
}
