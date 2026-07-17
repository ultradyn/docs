import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ActorHandleSchema,
  PersonalSettingsSchema,
  ProvenanceEventSchema,
  QuestionRecordSchema,
  RawArtifactManifestSchema,
  applyQuestionTransition,
  assignPriority,
  createIdGenerator,
  createPortableSchemaValidator,
  mergeSettings,
  queueForState,
} from "./index.js";

const now = "2026-07-16T00:00:00.000Z";

function question() {
  return QuestionRecordSchema.parse({
    schemaVersion: 1,
    id: "q-01J00000000000000000000000",
    title: "How are indexes rebuilt?",
    question: "How are indexes rebuilt?",
    state: "active",
    tier: "P3",
    priorityRationale: "Raw questions default to P3.",
    prioritySource: "rule",
    goals: ["implementation"],
    tags: ["raw"],
    askers: [{ id: "max", acceptance: "pending" }],
    origin: { kind: "raw" },
    depth: 0,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    provenance: [{ at: now, type: "logged", by: "registrar" }],
  });
}

describe("domain public seam", () => {
  it("keeps a canonical personal actor handle without inventing an identity", () => {
    expect(
      PersonalSettingsSchema.parse({ schemaVersion: 1 }).identity.actorHandle,
    ).toBe("");
    expect(ActorHandleSchema.parse("alex.review-1")).toBe("alex.review-1");
    expect(() => ActorHandleSchema.parse("Alex Review")).toThrow();
  });

  it("uses canonical state to select a repairable queue projection", () => {
    expect(queueForState("deferred")).toBe("deferred");
    expect(queueForState("accepted")).toBe("answered");
    expect(queueForState("merged")).toBe("active");
    expect(queueForState("reopened")).toBe("active");
  });

  it("enforces transition revisions and appends provenance", () => {
    const transitioned = applyQuestionTransition(question(), {
      to: "in-answer",
      expectedRevision: 0,
      at: "2026-07-16T00:01:00.000Z",
      by: "answerer:max",
    });

    expect(transitioned.state).toBe("in-answer");
    expect(transitioned.revision).toBe(1);
    expect(transitioned.provenance.at(-1)).toEqual({
      at: "2026-07-16T00:01:00.000Z",
      type: "state-transitioned",
      by: "answerer:max",
      details: { from: "active", to: "in-answer" },
    });
    expect(() =>
      applyQuestionTransition(transitioned, {
        to: "integrating",
        expectedRevision: 0,
        at: now,
        by: "critic",
      }),
    ).toThrow(/revision/i);
  });

  it("applies priority rules in decisive precedence order", () => {
    expect(
      assignPriority({ origin: "generated", depth: 4, contradiction: true }),
    ).toEqual({
      tier: "P1",
      rationale: "An unresolved contradiction is an active blocker.",
      source: "rule",
    });
    expect(
      assignPriority({ origin: "generated", depth: 4, demandPromoted: true })
        .tier,
    ).toBe("P2");
    expect(assignPriority({ origin: "raw", depth: 0 }).tier).toBe("P3");
    expect(assignPriority({ origin: "generated", depth: 1 }).tier).toBe("P4");
    expect(assignPriority({ origin: "generated", depth: 2 }).tier).toBe("P5");
    expect(
      assignPriority({
        origin: "generated",
        depth: 8,
        contradiction: true,
        override: { tier: "P4", rationale: "Maintainer triage decision." },
      }),
    ).toEqual({
      tier: "P4",
      rationale: "Maintainer triage decision.",
      source: "override",
    });
  });

  it("creates typed, monotonic ULIDs with an injected clock and randomness", () => {
    const ids = createIdGenerator({
      now: () => 1_700_000_000_000,
      random: () => 0.25,
    });
    const first = ids.next("question");
    const second = ids.next("question");

    expect(first).toMatch(/^q-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second > first).toBe(true);
  });

  it("merges personal preferences over portable project defaults without merging consent", () => {
    const merged = mergeSettings(
      {
        schemaVersion: 1,
        acceptanceTimeoutDays: 14,
        integrationMode: "manual",
        maintenance: { enabled: false, pollIntervalMinutes: 15 },
        providers: { llm: "fake-llm", stt: "fake-stt", codec: "fake-codec" },
      },
      {
        schemaVersion: 1,
        identity: { actorHandle: "max" },
        appearance: { theme: "dark", reducedMotion: true },
        audio: { preferredFormat: "ogg", keepConvertedAudio: true },
        providerPreferences: { llm: "codex-cli" },
        consent: {
          "codex-cli:model": {
            decision: "granted",
            decidedAt: now,
            sourceId: "codex-cli",
            scope: "model",
          },
        },
      },
    );

    expect(merged.effective.providers).toEqual({
      llm: "codex-cli",
      stt: "fake-stt",
      codec: "fake-codec",
    });
    expect(merged.effective.appearance.theme).toBe("dark");
    expect(merged.personal.identity.actorHandle).toBe("max");
    expect("consent" in merged.effective).toBe(false);
    expect(merged.personal.consent["codex-cli:model"]?.decision).toBe(
      "granted",
    );
  });

  it("keeps every shipped portable JSON Schema in parity with canonical Zod", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const schemas = existsSync(join(root, "scaffold", "schemas"))
      ? join(root, "scaffold", "schemas")
      : join(root, "schemas");
    const specifications = [
      {
        name: "questionRecord",
        schemaFile: "question-record.schema.json",
        corpusFile: "question-record.corpus.json",
        canonical: QuestionRecordSchema,
      },
      {
        name: "provenanceEvent",
        schemaFile: "provenance-event.schema.json",
        corpusFile: "provenance-event.corpus.json",
        canonical: ProvenanceEventSchema,
      },
      {
        name: "rawArtifactManifest",
        schemaFile: "raw-artifact-manifest.schema.json",
        corpusFile: "raw-artifact-manifest.corpus.json",
        canonical: RawArtifactManifestSchema,
      },
    ] as const;
    type SchemaName = (typeof specifications)[number]["name"];
    const documents = Object.fromEntries(
      await Promise.all(
        specifications.map(async (specification) => [
          specification.name,
          JSON.parse(
            await readFile(join(schemas, specification.schemaFile), "utf8"),
          ) as object,
        ]),
      ),
    ) as Record<SchemaName, object>;
    const validatePortable = createPortableSchemaValidator({
      schemas: documents,
    });

    for (const specification of specifications) {
      const corpus = JSON.parse(
        await readFile(join(schemas, specification.corpusFile), "utf8"),
      ) as {
        base: Record<string, unknown>;
        cases: Array<{
          name: string;
          valid: boolean;
          overrides: Record<string, unknown>;
        }>;
      };
      for (const testCase of corpus.cases) {
        const candidate = { ...corpus.base, ...testCase.overrides };
        expect(
          specification.canonical.safeParse(candidate).success,
          `${specification.name}/${testCase.name}: Zod`,
        ).toBe(testCase.valid);
        expect(
          validatePortable(specification.name, candidate).valid,
          `${specification.name}/${testCase.name}: portable validator`,
        ).toBe(testCase.valid);
      }
    }
  });
});
