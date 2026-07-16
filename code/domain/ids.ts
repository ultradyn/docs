import { monotonicFactory } from "ulid";

export type IdKind =
  | "question"
  | "answer"
  | "finding"
  | "artifact"
  | "change-request"
  | "audio-session";

const prefixes: Record<IdKind, string> = {
  question: "q",
  answer: "ans",
  finding: "f",
  artifact: "art",
  "change-request": "cr",
  "audio-session": "aud",
};

export interface IdGenerator {
  next(kind: IdKind, at?: number): string;
}

export function createIdGenerator(
  options: {
    now?: () => number;
    random?: () => number;
  } = {},
): IdGenerator {
  const now = options.now ?? Date.now;
  const generate = monotonicFactory(options.random ?? Math.random);
  return {
    next(kind, at = now()) {
      return `${prefixes[kind]}-${generate(at)}`;
    },
  };
}
