import {
  IngestionQuestionLinkSchema,
  QuestionLinkInputSchema,
  type IngestionQuestionLink,
} from "../../domain/ingest/question-link.js";
import type { IngestResult } from "../../domain/ingest/types.js";
import type { QuestionRecord } from "../../domain/schemas.js";

export type QuestionLinkError =
  | "INVALID_LINK"
  | "QUESTION_NOT_FOUND"
  | "ORIGIN_MISMATCH"
  | "LINK_EXISTS";

export interface QuestionReader {
  getQuestion(id: string): Promise<QuestionRecord | undefined>;
}

export interface QuestionLinkStore {
  get(questionId: string): IngestionQuestionLink | undefined;
  set(link: IngestionQuestionLink): void;
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
  return {
    get: (questionId) => links.get(questionId),
    set: (link) => {
      links.set(link.questionId, link);
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

      const record = await questions.getQuestion(parsed.data.questionId);
      if (!record) {
        return failure(
          "QUESTION_NOT_FOUND",
          `Unknown question ${parsed.data.questionId}.`,
        );
      }

      // The link records provenance beside the canonical question; it must
      // agree with — never replace — the record's own origin (N6). "reverse"
      // links may target either kind: reverse-ingested roots are created as
      // raw records by a system actor.
      const kind = record.origin.kind;
      if (
        (parsed.data.origin === "human" && kind !== "raw") ||
        (parsed.data.origin === "ingestion-generated" && kind !== "generated")
      ) {
        return failure(
          "ORIGIN_MISMATCH",
          `Link origin ${parsed.data.origin} contradicts canonical origin ${kind}.`,
        );
      }

      if (links.get(record.id)) {
        return failure("LINK_EXISTS", `Question ${record.id} is already linked.`);
      }

      const link = IngestionQuestionLinkSchema.parse({
        schemaVersion: 1,
        ...parsed.data,
        createdRevision: record.revision,
      });
      links.set(link);
      return { ok: true, value: link };
    },

    read(questionId) {
      const link = links.get(questionId);
      if (!link) {
        return Promise.resolve(
          failure("LINK_NOT_FOUND", `Question ${questionId} has no link.`),
        );
      }
      return Promise.resolve({ ok: true, value: link });
    },
  };
}
