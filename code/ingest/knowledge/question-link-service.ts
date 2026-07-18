import { AsyncLocalStorage } from "node:async_hooks";

import {
  IngestionQuestionLinkSchema,
  QuestionLinkInputSchema,
  type IngestionQuestionLink,
  type QuestionLinkStore,
} from "../../domain/ingest/question-link.js";
import type { IngestResult } from "../../domain/ingest/types.js";
import type { QuestionRecord } from "../../domain/schemas.js";
import { QuestionNotFoundError } from "../../repository/knowledge-repository.js";

export type QuestionLinkError =
  | "INVALID_LINK"
  | "QUESTION_NOT_FOUND"
  | "ORIGIN_MISMATCH"
  | "LINK_EXISTS";

export interface QuestionReader {
  getQuestion(id: string): Promise<QuestionRecord | undefined>;
}

export interface QuestionLinkService {
  link(
    input: unknown,
  ): Promise<IngestResult<IngestionQuestionLink, QuestionLinkError>>;
  read(
    questionId: string,
  ): Promise<IngestResult<IngestionQuestionLink, "LINK_NOT_FOUND">>;
}

export function createInMemoryQuestionLinkStore(): QuestionLinkStore {
  const links = new Map<string, IngestionQuestionLink>();
  const holder = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    get: async (questionId) => links.get(questionId),
    create: async (input) => {
      const link = IngestionQuestionLinkSchema.parse(input);
      if (links.has(link.questionId)) return false;
      links.set(link.questionId, link);
      return true;
    },
    locked: <T>(operation: () => Promise<T>): Promise<T> => {
      if (holder.getStore()) return operation();
      const run = () => holder.run(true, operation);
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function failure<Code extends string>(
  code: Code,
  message: string,
): { ok: false; code: Code; message: string } {
  return { ok: false, code, message };
}

export function createQuestionLinkService(options: {
  questions: QuestionReader;
  links: QuestionLinkStore;
}): QuestionLinkService {
  const { questions, links } = options;
  return {
    async link(input) {
      const parsed = QuestionLinkInputSchema.safeParse(input);
      if (!parsed.success) {
        return failure(
          "INVALID_LINK",
          parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; "),
        );
      }

      // Revision capture and publication run inside the store's exclusive
      // section, so a concurrent lifecycle transition (which takes the same
      // canonical repository lock) cannot interleave a stale createdRevision.
      return links.locked(async () => {
        let record: QuestionRecord | undefined;
        try {
          record = await questions.getQuestion(parsed.data.questionId);
        } catch (error) {
          if (error instanceof QuestionNotFoundError) {
            return failure(
              "QUESTION_NOT_FOUND",
              `Unknown question ${parsed.data.questionId}.`,
            );
          }
          throw error;
        }
        if (!record) {
          return failure(
            "QUESTION_NOT_FOUND",
            `Unknown question ${parsed.data.questionId}.`,
          );
        }

        // The link records provenance beside the canonical question; it must
        // agree with — never replace — the record's own origin (N6). "reverse"
        // links target canonical raw records: reverse-ingested roots are
        // created as raw records by a system actor.
        const kind = record.origin.kind;
        if (
          (parsed.data.origin === "human" && kind !== "raw") ||
          (parsed.data.origin === "ingestion-generated" &&
            kind !== "generated") ||
          (parsed.data.origin === "reverse" && kind !== "raw")
        ) {
          return failure(
            "ORIGIN_MISMATCH",
            `Link origin ${parsed.data.origin} contradicts canonical origin ${kind}.`,
          );
        }

        const link = IngestionQuestionLinkSchema.parse({
          schemaVersion: 1,
          ...parsed.data,
          createdRevision: record.revision,
        });
        if (!(await links.create(link))) {
          return failure(
            "LINK_EXISTS",
            `Question ${record.id} is already linked.`,
          );
        }
        return { ok: true, value: link };
      });
    },

    async read(questionId) {
      const link = await links.get(questionId);
      if (!link) {
        return failure("LINK_NOT_FOUND", `Question ${questionId} has no link.`);
      }
      return { ok: true, value: link };
    },
  };
}
