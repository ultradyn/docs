import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const fixtureRoot = join(import.meta.dirname, "fixtures", "ingest-corpus");

interface CorpusFile {
  id: string;
  path: string;
  sha256: string;
  scenarios: string[];
}

interface CorpusUnit {
  id: string;
  fileId: string;
  locator: string;
  disposition:
    | "claim-evidence"
    | "duplicate"
    | "contradiction"
    | "disconnected"
    | "context-only";
  scenarios: string[];
}

interface CorpusQuestion {
  id: string;
  text: string;
  evidenceUnitIds: string[];
}

interface CorpusClaim {
  id: string;
  text: string;
  qualifiers: string[];
  lifecycle: "current" | "deprecated";
  evidenceUnitIds: string[];
  reusable: boolean;
}

interface ExpectedCorpusGraph {
  schemaVersion: 1;
  corpusId: string;
  provenance: { kind: "curated-adaptation"; sources: string[] };
  files: CorpusFile[];
  units: CorpusUnit[];
  questions: CorpusQuestion[];
  claims: CorpusClaim[];
  duplicates: Array<{
    canonicalUnitId: string;
    duplicateUnitIds: string[];
    outcome: "merge-with-provenance" | "keep-separate";
  }>;
  contradictions: Array<{
    unitIds: string[];
    outcome: "block-until-resolved";
  }>;
  unsupportedQuestions: string[];
}

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
  return JSON.parse(
    await readFile(join(fixtureRoot, corpus, "expected-graph.json"), "utf8"),
  ) as ExpectedCorpusGraph;
}

const expectedCorpusDigests = {
  tiny: "17f0ec7d8d20a4ea8e937469a580a9dd2eabb36f199ee19f921ac761598e452f",
  small: "d18f2ab3b169cdf1936ba6321237b0775a10e46a0343236a0d85658d3a8b0b97",
} as const;

async function assertCorpusIntegrity(
  corpus: keyof typeof expectedCorpusDigests,
): Promise<ExpectedCorpusGraph> {
  const graph = await loadCorpus(corpus);
  expect(graph.schemaVersion).toBe(1);
  expect(graph.corpusId).toBe(corpus);
  expect(graph.provenance.kind).toBe("curated-adaptation");
  expect(graph.provenance.sources.length).toBeGreaterThan(0);

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

  for (const unit of graph.units) expect(fileIds.has(unit.fileId)).toBe(true);
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
    expect(duplicate.duplicateUnitIds.length).toBeGreaterThan(0);
    for (const unitId of duplicate.duplicateUnitIds)
      expect(unitIds.has(unitId)).toBe(true);
  }
  for (const contradiction of graph.contradictions) {
    expect(contradiction.unitIds.length).toBeGreaterThanOrEqual(2);
    for (const unitId of contradiction.unitIds)
      expect(unitIds.has(unitId)).toBe(true);
  }
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
    expect(graph.provenance.sources).toContain(
      "this repository's documentation",
    );
    expect(
      graph.claims.filter((claim) => claim.reusable).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
