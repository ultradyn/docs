import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const fixtureRoot = join(import.meta.dirname, "fixtures", "ingest-corpus");
const scenarioSchema = z.enum([
  "overview",
  "procedure",
  "deprecation",
  "contradiction",
  "disconnected-note",
  "duplicate-content",
  "unsupported-question",
  "repository-doc-subset",
]);
const identifierSchema = z.string().min(1);
const unitIdListSchema = z.array(identifierSchema);

const expectedCorpusGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusId: z.enum(["tiny", "small"]),
    provenance: z
      .object({
        kind: z.literal("curated-adaptation"),
        sources: z
          .array(z.string().regex(/^(?:CONTEXT\.md|docs\/)[^#]*(?:#[^#]+)?$/))
          .min(1),
      })
      .strict(),
    files: z.array(
      z
        .object({
          id: identifierSchema,
          path: z.string().regex(/^[a-z0-9][a-z0-9./-]*\.md$/),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          scenarios: z.array(scenarioSchema).min(1),
        })
        .strict(),
    ),
    units: z.array(
      z
        .object({
          id: identifierSchema,
          fileId: identifierSchema,
          locator: z.string().min(1),
          disposition: z.enum([
            "claim-evidence",
            "duplicate",
            "contradiction",
            "disconnected",
            "context-only",
          ]),
          scenarios: z.array(scenarioSchema).min(1),
        })
        .strict(),
    ),
    questions: z.array(
      z
        .object({
          id: identifierSchema,
          text: z.string().min(1),
          evidenceUnitIds: unitIdListSchema,
        })
        .strict(),
    ),
    claims: z.array(
      z
        .object({
          id: identifierSchema,
          text: z.string().min(1),
          qualifiers: z.array(z.string().min(1)).min(1),
          lifecycle: z.enum(["current", "deprecated"]),
          evidenceUnitIds: unitIdListSchema.min(1),
          reusable: z.boolean(),
        })
        .strict(),
    ),
    duplicates: z.array(
      z
        .object({
          canonicalUnitId: identifierSchema,
          duplicateUnitIds: unitIdListSchema.min(1),
          outcome: z.enum(["merge-with-provenance", "keep-separate"]),
        })
        .strict(),
    ),
    contradictions: z.array(
      z
        .object({
          unitIds: unitIdListSchema.min(2),
          outcome: z.literal("block-until-resolved"),
        })
        .strict(),
    ),
    unsupportedQuestions: z.array(identifierSchema),
  })
  .strict();

type ExpectedCorpusGraph = z.infer<typeof expectedCorpusGraphSchema>;

async function sourcePaths(corpus: string): Promise<string[]> {
  const sourceRoot = join(fixtureRoot, corpus, "source");
  const paths: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else paths.push(relative(sourceRoot, path).replaceAll("\\", "/"));
    }
  }

  await visit(sourceRoot);
  return paths.sort();
}

async function loadCorpus(corpus: string): Promise<ExpectedCorpusGraph> {
  return expectedCorpusGraphSchema.parse(
    JSON.parse(
      await readFile(join(fixtureRoot, corpus, "expected-graph.json"), "utf8"),
    ),
  );
}

const expectedCorpusDigests = {
  tiny: "17f0ec7d8d20a4ea8e937469a580a9dd2eabb36f199ee19f921ac761598e452f",
  small: "d18f2ab3b169cdf1936ba6321237b0775a10e46a0343236a0d85658d3a8b0b97",
} as const;

const expectedGraphDigests = {
  tiny: "a6261cedc3818bd09d2acee02cb92e9d6fe5d0aa9a12aaf0c9a40e167f7cdfdc",
  small: "a539b027ed0e8d39f3b986fbbab58581d54919791b7ecf48664a4b20f720c9c8",
} as const;

async function assertCorpusIntegrity(
  corpus: keyof typeof expectedCorpusDigests,
): Promise<ExpectedCorpusGraph> {
  const graph = await loadCorpus(corpus);
  expect(graph.schemaVersion).toBe(1);
  expect(graph.corpusId).toBe(corpus);
  expect(graph.provenance.kind).toBe("curated-adaptation");
  expect(graph.provenance.sources.length).toBeGreaterThan(0);
  expect(graph.provenance.sources.every((source) => source.includes("#"))).toBe(
    true,
  );
  const graphBytes = await readFile(
    join(fixtureRoot, corpus, "expected-graph.json"),
  );
  expect(createHash("sha256").update(graphBytes).digest("hex")).toBe(
    expectedGraphDigests[corpus],
  );
  for (const source of graph.provenance.sources) {
    const [relativeSource, heading] = source.split("#", 2);
    expect(relativeSource).toBeTruthy();
    expect(heading).toBeTruthy();
    const sourceText = await readFile(
      join(process.cwd(), relativeSource ?? ""),
      "utf8",
    );
    expect(sourceText, source).toContain(`# ${heading}`);
  }

  const fileIds = new Set(graph.files.map((file) => file.id));
  const unitIds = new Set(graph.units.map((unit) => unit.id));
  const questionIds = new Set(graph.questions.map((question) => question.id));
  expect(fileIds.size).toBe(graph.files.length);
  expect(unitIds.size).toBe(graph.units.length);
  expect(questionIds.size).toBe(graph.questions.length);

  expect(graph.files.map((file) => file.path).sort()).toEqual(
    await sourcePaths(corpus),
  );
  expect(
    createHash("sha256")
      .update(
        graph.files
          .map((file) => `${file.path}:${file.sha256}`)
          .sort()
          .join("\n"),
      )
      .digest("hex"),
  ).toBe(expectedCorpusDigests[corpus]);
  for (const file of graph.files) {
    expect(file.path).toMatch(/^[a-z0-9][a-z0-9./-]*\.md$/);
    const bytes = await readFile(
      join(fixtureRoot, corpus, "source", file.path),
    );
    expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(
      file.sha256,
    );
  }

  for (const unit of graph.units) {
    expect(fileIds.has(unit.fileId)).toBe(true);
    const file = graph.files.find((candidate) => candidate.id === unit.fileId);
    expect(file, unit.id).toBeDefined();
    const sourceText = await readFile(
      join(fixtureRoot, corpus, "source", file?.path ?? ""),
      "utf8",
    );
    expect(sourceText, `${unit.id}:${unit.locator}`).toContain(unit.locator);
  }
  for (const fileId of fileIds)
    expect(
      graph.units.some((unit) => unit.fileId === fileId),
      fileId,
    ).toBe(true);
  for (const question of graph.questions) {
    for (const unitId of question.evidenceUnitIds)
      expect(unitIds.has(unitId)).toBe(true);
  }
  for (const claim of graph.claims) {
    expect(claim.qualifiers.length, claim.id).toBeGreaterThan(0);
    for (const unitId of claim.evidenceUnitIds)
      expect(unitIds.has(unitId)).toBe(true);
  }
  for (const duplicate of graph.duplicates) {
    expect(unitIds.has(duplicate.canonicalUnitId)).toBe(true);
    expect(
      graph.units.find((unit) => unit.id === duplicate.canonicalUnitId)
        ?.disposition,
    ).not.toBe("duplicate");
    for (const unitId of duplicate.duplicateUnitIds) {
      expect(unitIds.has(unitId)).toBe(true);
      expect(graph.units.find((unit) => unit.id === unitId)?.disposition).toBe(
        "duplicate",
      );
    }
  }
  expect(
    graph.units
      .filter((unit) => unit.disposition === "duplicate")
      .map((unit) => unit.id)
      .sort(),
  ).toEqual(
    graph.duplicates.flatMap((duplicate) => duplicate.duplicateUnitIds).sort(),
  );
  for (const contradiction of graph.contradictions) {
    for (const unitId of contradiction.unitIds) {
      expect(unitIds.has(unitId)).toBe(true);
      expect(
        graph.units.find((unit) => unit.id === unitId)?.scenarios,
      ).toContain("contradiction");
    }
    expect(
      contradiction.unitIds.some(
        (unitId) =>
          graph.units.find((unit) => unit.id === unitId)?.disposition ===
          "contradiction",
      ),
    ).toBe(true);
  }
  expect(
    graph.units
      .filter((unit) => unit.disposition === "contradiction")
      .every((unit) =>
        graph.contradictions.some((record) => record.unitIds.includes(unit.id)),
      ),
  ).toBe(true);
  for (const questionId of graph.unsupportedQuestions) {
    expect(questionIds.has(questionId)).toBe(true);
    expect(
      graph.questions.find((question) => question.id === questionId)
        ?.evidenceUnitIds,
    ).toEqual([]);
  }
  expect(
    graph.questions
      .filter((question) => question.evidenceUnitIds.length === 0)
      .map((question) => question.id),
  ).toEqual(graph.unsupportedQuestions);

  return graph;
}

describe("labelled ingestion corpus fixtures", () => {
  test("tiny labels every required scenario and source-unit disposition", async () => {
    const graph = await assertCorpusIntegrity("tiny");
    const scenarios = new Set([
      ...graph.files.flatMap((file) => file.scenarios),
      ...graph.units.flatMap((unit) => unit.scenarios),
    ]);

    expect(scenarios).toEqual(
      new Set([
        "overview",
        "procedure",
        "deprecation",
        "contradiction",
        "disconnected-note",
        "duplicate-content",
        "unsupported-question",
      ]),
    );
    expect(graph.units.every((unit) => unit.disposition.length > 0)).toBe(true);
    expect(graph.duplicates).toEqual([
      {
        canonicalUnitId: "tiny-unit-overview",
        duplicateUnitIds: ["tiny-unit-overview-copy"],
        outcome: "merge-with-provenance",
      },
    ]);
    expect(graph.contradictions).toEqual([
      {
        unitIds: ["tiny-unit-procedure", "tiny-unit-conflicting-procedure"],
        outcome: "block-until-resolved",
      },
    ]);
    expect(graph.unsupportedQuestions).toEqual(["tiny-question-unsupported"]);
    expect(graph.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tiny-claim-restart",
          qualifiers: ["after changing project settings", "maintainer mode"],
          lifecycle: "current",
        }),
        expect.objectContaining({
          id: "tiny-claim-legacy-export",
          qualifiers: ["projects created before schema version 2"],
          lifecycle: "deprecated",
        }),
      ]),
    );
  });

  test("small is a stable repository-doc subset with reusable claims", async () => {
    const graph = await assertCorpusIntegrity("small");
    expect(graph.files.length).toBeGreaterThanOrEqual(20);
    expect(graph.provenance.sources).toContain("CONTEXT.md#Knowledge flow");
    expect(
      graph.claims.filter((claim) => claim.reusable).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
