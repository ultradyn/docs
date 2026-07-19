import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  Sha256,
  SnapshotId,
  SourceFile,
  SourceFileId,
  SourceRepresentation,
  SourceRepresentationId,
  SourceUnit,
} from "../../domain/ingest/index.js";
import {
  SearchReceiptSchema,
  computeIndexedRepresentationsSha256,
} from "../../domain/ingest/search-receipt.js";
import { auditRepresentation, unitizeRepresentation } from "../source/index.js";

import {
  createLexicalIndex,
  matchesScope,
  receiptIdFor,
  type LexicalIndex,
  type SearchResponse,
} from "./lexical-index.js";

function sha256(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

const SNAPSHOT_ID = `snap-${"b".repeat(64)}` as SnapshotId;

interface Corpus {
  readonly units: readonly SourceUnit[];
  readonly files: readonly SourceFile[];
  readonly representations: readonly SourceRepresentation[];
}

/**
 * Drive the real extractor→audit→unitizer path so unit IDs and text digests
 * are authentic. Hand-cast digests would let a broken TEXT_MISMATCH pass.
 */
function markdownFile(
  logicalPath: string,
  fileIdSeed: string,
  representationId: string,
  text: string,
  version = 1,
): Corpus {
  const id = `file-${fileIdSeed.repeat(64).slice(0, 64)}` as SourceFileId;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let offset = 0;
  const locatorMap: SourceRepresentation["locatorMap"] = lines.map(
    (line, index) => {
      const start = offset;
      const end = start + line.length;
      offset = end + 1;
      const span = {
        utf16Start: start,
        utf16End: end,
        lineStart: index + 1,
        columnStart: 1,
        lineEnd: index + 1,
        columnEnd: line.length + 1,
      };
      return {
        kind: "line" as const,
        normalized: span,
        original: {
          byteStart: start,
          byteEnd: end,
          lineStart: index + 1,
          columnStart: 1,
          lineEnd: index + 1,
          columnEnd: line.length + 1,
        },
      };
    },
  );
  const representation: SourceRepresentation = {
    schemaVersion: 1,
    id: representationId as SourceRepresentationId,
    sourceFileId: id,
    version,
    kind: "markdown",
    normalizedText: text,
    locatorMap,
    warnings: [],
  };
  const sourceFile: SourceFile = {
    schemaVersion: 1,
    id,
    snapshotId: SNAPSHOT_ID,
    logicalPath,
    mediaType: "text/markdown",
    size: Buffer.byteLength(text),
    sha256: sha256(text),
  };
  const audited = auditRepresentation(representation);
  if (!audited.ok) throw new Error(audited.message);
  const unitized = unitizeRepresentation({
    sourceFile,
    representation,
    audit: audited.value,
  });
  if (!unitized.ok) throw new Error(unitized.message);
  return {
    units: unitized.value,
    files: [sourceFile],
    representations: [representation],
  };
}

const GUIDE_TEXT = [
  "# Deterministic Source Plane",
  "",
  "Body mentions AUDIT_REQUIRED here.",
  "",
  "## Details",
  "",
  "More body text about lexical retrieval.",
  "",
  "## Codes",
  "",
  "Codes E123 and HTTP-404 apply. The CPU and C++ are fine.",
  "",
  "## Café Ordering",
  "",
  "Accented body text for structural path queries.",
  "",
].join("\n");

const OTHER_TEXT = [
  "# Details",
  "",
  "Other body text about alias collisions.",
  "",
  "## Audit Required",
  "",
  "Nothing here.",
  "",
].join("\n");

function guide(): Corpus {
  return markdownFile(
    "docs/guide.md",
    "a",
    "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    GUIDE_TEXT,
  );
}

function other(): Corpus {
  return markdownFile(
    "docs/other.md",
    "c",
    "repr-01ARZ3NDEKTSV4RRFFQ69G5FBW",
    OTHER_TEXT,
  );
}

function merge(...parts: readonly Corpus[]): Corpus {
  return {
    units: parts.flatMap((part) => [...part.units]),
    files: parts.flatMap((part) => [...part.files]),
    representations: parts.flatMap((part) => [...part.representations]),
  };
}

function sectionTitled(corpus: Corpus, heading: string): SourceUnit {
  const unit = corpus.units.find(
    (candidate) =>
      candidate.kind === "section" && candidate.headingPath.at(-1) === heading,
  );
  if (!unit) throw new Error(`no section titled ${heading}`);
  return unit;
}

function paragraphUnder(corpus: Corpus, heading: string): SourceUnit {
  const unit = corpus.units.find(
    (candidate) =>
      candidate.kind === "paragraph" &&
      candidate.headingPath.at(-1) === heading,
  );
  if (!unit) throw new Error(`no paragraph under ${heading}`);
  return unit;
}

function unitOfKind(corpus: Corpus, kind: SourceUnit["kind"]): SourceUnit {
  const unit = corpus.units.find((candidate) => candidate.kind === kind);
  if (!unit) throw new Error(`no ${kind} unit in corpus`);
  return unit;
}

function expectDeepFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const item of value) expectDeepFrozen(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) expectDeepFrozen(item);
  }
}

async function built(
  corpus: Corpus,
  snapshotId: SnapshotId = SNAPSHOT_ID,
): Promise<LexicalIndex> {
  const index = createLexicalIndex();
  const result = await index.build(snapshotId, corpus);
  if (!result.ok) {
    throw new Error(`expected build ok: ${result.code} ${result.message}`);
  }
  return index;
}

async function searchOk(
  index: LexicalIndex,
  request: Parameters<LexicalIndex["search"]>[0],
): Promise<SearchResponse> {
  const result = await index.search(request);
  if (!result.ok) {
    throw new Error(`expected search ok: ${result.code} ${result.message}`);
  }
  return result.value;
}

describe("createLexicalIndex build validation", () => {
  it("rejects duplicate source unit identities", async () => {
    const corpus = guide();
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      units: [...corpus.units, corpus.units[0]!],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DUPLICATE_UNIT");
  });

  it("rejects duplicate file identities", async () => {
    const corpus = guide();
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      files: [...corpus.files, corpus.files[0]!],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DUPLICATE_CONTEXT");
  });

  it("rejects duplicate representation identities", async () => {
    const corpus = guide();
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      representations: [...corpus.representations, corpus.representations[0]!],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DUPLICATE_CONTEXT");
  });

  it("rejects mixed representation versions for one source file", async () => {
    const primary = guide();
    // Construction note: unitizer unit ids are content-deterministic, so two
    // full unitizations of the same text collide as DUPLICATE_UNIT. Pin the
    // mixed-version rule with one unit set and two representation records that
    // share a sourceFileId (second is unreferenced context).
    const secondRepresentation: SourceRepresentation = {
      ...primary.representations[0]!,
      id: "repr-01ARZ3NDEKTSV4RRFFQ69G5FCX" as SourceRepresentationId,
      version: 2,
    };
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      units: primary.units,
      files: primary.files,
      representations: [...primary.representations, secondRepresentation],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DUPLICATE_CONTEXT");
  });

  it("rejects unresolved file references", async () => {
    const corpus = guide();
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      files: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects unresolved representation references", async () => {
    const corpus = guide();
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      representations: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects cross-bound representation sourceFileId", async () => {
    const corpus = merge(guide(), other());
    const [guideRepresentation, ...rest] = corpus.representations;
    const rebound: SourceRepresentation = {
      ...guideRepresentation!,
      sourceFileId: corpus.files[1]!.id,
    };
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      representations: [rebound, ...rest],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects text digest mismatch on rebound selected text", async () => {
    const corpus = guide();
    const [representation] = corpus.representations;
    const tampered: SourceRepresentation = {
      ...representation!,
      normalizedText: representation!.normalizedText.replace(
        "More body text",
        "More BODY text",
      ),
    };
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      representations: [tampered],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("TEXT_MISMATCH");
  });

  it("rejects out-of-range locators as UNRESOLVED_REFERENCE", async () => {
    const corpus = guide();
    const [representation] = corpus.representations;
    const truncated: SourceRepresentation = {
      ...representation!,
      normalizedText: representation!.normalizedText.slice(0, 10),
    };
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      representations: [truncated],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects hostile non-plain prototypes as INVALID_INPUT", async () => {
    const corpus = guide();
    const hostile = Object.create(null) as {
      units: SourceUnit[];
      files: SourceFile[];
      representations: SourceRepresentation[];
    };
    hostile.units = [...corpus.units];
    hostile.files = [...corpus.files];
    hostile.representations = [...corpus.representations];
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, hostile as Corpus);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });

  it("rejects malformed unit records as INVALID_INPUT", async () => {
    const corpus = guide();
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      ...corpus,
      units: [
        { ...corpus.units[0]!, kind: "chapter" } as unknown as SourceUnit,
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });

  it("accepts an empty corpus (healthy empty index)", async () => {
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, {
      units: [],
      files: [],
      representations: [],
    });
    expect(result.ok).toBe(true);
  });

  it("never throws on hostile or oversized input", async () => {
    const index = createLexicalIndex();
    await expect(
      index.build(SNAPSHOT_ID, null as unknown as Corpus),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await expect(
      index.build(SNAPSHOT_ID, {
        units: "nope",
        files: [],
        representations: [],
      } as unknown as Corpus),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});

describe("lexical content and structural search", () => {
  it("retrieves a unit by content query over rebound selected text", async () => {
    const corpus = merge(guide(), other());
    const index = await built(corpus);
    const detailsParagraph = paragraphUnder(guide(), "Details");
    const response = await searchOk(index, {
      query: "lexical retrieval",
      limit: 10,
    });
    expect(response.selectedIds).toContain(detailsParagraph.id);
    expect(response.receipt.selectedIds).toContain(detailsParagraph.id);
    expect(response.receipt.candidateIds).toContain(detailsParagraph.id);
  });

  it("retrieves by structural heading query", async () => {
    const corpus = guide();
    const index = await built(corpus);
    const cafe = sectionTitled(corpus, "Café Ordering");
    const response = await searchOk(index, {
      query: "Café Ordering",
      limit: 10,
    });
    expect(response.selectedIds).toContain(cafe.id);
  });

  it("retrieves by logical path structural field", async () => {
    const corpus = merge(guide(), other());
    const index = await built(corpus);
    const guideDocument = unitOfKind(guide(), "document");
    const response = await searchOk(index, {
      query: "docs/guide.md",
      limit: 10,
    });
    expect(response.selectedIds).toContain(guideDocument.id);
  });

  it("integrates exact-map aliases into retrieval", async () => {
    const corpus = guide();
    const index = await built(corpus);
    const document = unitOfKind(corpus, "document");
    // Path alias from exact map should surface the document unit.
    const response = await searchOk(index, {
      query: "docs/guide.md",
      limit: 5,
    });
    expect(response.selectedIds).toContain(document.id);

    const byId = await searchOk(index, { query: document.id, limit: 5 });
    expect(byId.selectedIds).toContain(document.id);
  });

  it("stable-sorts tied scores by SourceUnitId", async () => {
    const corpus = merge(guide(), other());
    const index = await built(corpus);
    const first = await searchOk(index, { query: "body text", limit: 20 });
    const second = await searchOk(index, { query: "body text", limit: 20 });
    expect(first.selectedIds).toEqual(second.selectedIds);
    expect(first.hits.length).toBeGreaterThan(0);
    for (let i = 1; i < first.hits.length; i += 1) {
      const prev = first.hits[i - 1]!;
      const curr = first.hits[i]!;
      if (prev.score === curr.score) {
        expect(prev.unitId < curr.unitId).toBe(true);
      } else {
        expect(prev.score).toBeGreaterThan(curr.score);
      }
    }
    expect(first.hits.map((hit) => hit.unitId)).toEqual(first.selectedIds);
  });
});

describe("filters apply before selection", () => {
  it("snapshot filter excludes a mismatching built snapshot", async () => {
    const corpus = guide();
    const index = await built(corpus);
    const unfiltered = await searchOk(index, { query: "lexical", limit: 10 });
    expect(unfiltered.selectedIds.length).toBeGreaterThan(0);
    const response = await searchOk(index, {
      query: "lexical",
      filters: {
        snapshotId: `snap-${"c".repeat(64)}` as SnapshotId,
      },
      limit: 10,
    });
    expect(response.selectedIds).toEqual([]);
    expect(response.receipt.selectedIds).toEqual([]);
    expect(response.receipt.filters.snapshotId).toBe(`snap-${"c".repeat(64)}`);
  });

  it("scope path prefix filters candidates before selection with nonempty evidence", async () => {
    const corpus = merge(guide(), other());
    const index = await built(corpus);
    const unfiltered = await searchOk(index, { query: "body", limit: 20 });
    expect(unfiltered.selectedIds.length).toBeGreaterThan(0);

    const otherOnly = await searchOk(index, {
      query: "body",
      filters: { scope: ["docs/other.md"] },
      limit: 20,
    });
    expect(otherOnly.selectedIds.length).toBeGreaterThan(0);
    expect(otherOnly.selectedIds.length).toBeLessThanOrEqual(
      unfiltered.selectedIds.length,
    );
    for (const id of otherOnly.selectedIds) {
      const unit = corpus.units.find((candidate) => candidate.id === id);
      expect(unit).toBeDefined();
      const file = corpus.files.find(
        (candidate) => candidate.id === unit!.sourceFileId,
      );
      expect(file?.logicalPath).toBe("docs/other.md");
      expect(unfiltered.selectedIds).toContain(id);
    }
  });

  it("scope directory boundary does not match docs-old when scope is docs", async () => {
    expect(matchesScope("docs/guide.md", ["docs"])).toBe(true);
    expect(matchesScope("docs", ["docs"])).toBe(true);
    expect(matchesScope("docs-old/guide.md", ["docs"])).toBe(false);
    expect(matchesScope("docs/guide.md", ["docs/"])).toBe(true);
    expect(matchesScope("docs-old/guide.md", ["docs/"])).toBe(false);
  });

  it("unitKinds filter applies before selection with nonempty evidence", async () => {
    const corpus = guide();
    const index = await built(corpus);
    const unfiltered = await searchOk(index, { query: "Details", limit: 20 });
    expect(unfiltered.selectedIds.length).toBeGreaterThan(0);

    const sectionsOnly = await searchOk(index, {
      query: "Details",
      filters: { unitKinds: ["section"] },
      limit: 20,
    });
    expect(sectionsOnly.selectedIds.length).toBeGreaterThan(0);
    for (const id of sectionsOnly.selectedIds) {
      const unit = corpus.units.find((candidate) => candidate.id === id);
      expect(unit?.kind).toBe("section");
      expect(unfiltered.selectedIds).toContain(id);
    }
  });
});

describe("healthy empty vs INDEX_UNAVAILABLE", () => {
  it("returns ok with empty selected when the query misses", async () => {
    const index = await built(guide());
    const response = await searchOk(index, {
      query: "zzzz-no-such-token-qqqq",
      limit: 10,
    });
    expect(response.selectedIds).toEqual([]);
    expect(response.receipt.selectedIds).toEqual([]);
    expect(response.receipt.candidateIds).toEqual([]);
    const receipt = SearchReceiptSchema.safeParse(response.receipt);
    expect(receipt.success).toBe(true);
  });

  it("returns INDEX_UNAVAILABLE when no index has been built", async () => {
    const index = createLexicalIndex();
    const result = await index.search({ query: "anything", limit: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INDEX_UNAVAILABLE");
  });

  it("returns INDEX_UNAVAILABLE after discard", async () => {
    const index = await built(guide());
    index.discard();
    const result = await index.search({ query: "lexical", limit: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INDEX_UNAVAILABLE");
  });
});

describe("receipt corpus digest and rebuild determinism", () => {
  it("binds receipt corpus digest to representation bindings not bare ids", async () => {
    const corpus = merge(guide(), other());
    const index = await built(corpus);
    const response = await searchOk(index, { query: "body", limit: 5 });
    const expected = computeIndexedRepresentationsSha256(
      corpus.representations.map((representation) => ({
        id: representation.id,
        version: representation.version,
        sourceFileId: representation.sourceFileId,
        normalizedTextSha256: sha256(representation.normalizedText),
      })),
    );
    expect(response.receipt.indexedRepresentationsSha256).toBe(expected);
    expect(response.receipt.snapshotId).toBe(SNAPSHOT_ID);
  });

  it("changes corpus digest on same-snapshot representation repair", async () => {
    const base = guide();
    const index = await built(base);
    const first = await searchOk(index, { query: "body", limit: 5 });

    const repairedText = GUIDE_TEXT.replace(
      "More body text about lexical retrieval.",
      "More body text about lexical retrieval repaired.",
    );
    const repaired = markdownFile(
      "docs/guide.md",
      "a",
      "repr-01ARZ3NDEKTSV4RRFFQ69G5FCX",
      repairedText,
      2,
    );
    const index2 = createLexicalIndex();
    const build2 = await index2.build(SNAPSHOT_ID, repaired);
    expect(build2.ok).toBe(true);
    const second = await searchOk(index2, { query: "body", limit: 5 });

    expect(first.receipt.snapshotId).toBe(second.receipt.snapshotId);
    expect(first.receipt.indexedRepresentationsSha256).not.toBe(
      second.receipt.indexedRepresentationsSha256,
    );
  });

  it("changes corpus digest when content changes under a reused representation id", async () => {
    const original = guide();
    const [rep] = original.representations;
    const mutatedText = GUIDE_TEXT.replace(
      "More body text about lexical retrieval.",
      "More body text about lexical retrieval MUTATED.",
    );
    // Same rep id and version — only content differs; ids-only digest would not change.
    const mutatedRep: SourceRepresentation = {
      ...rep!,
      normalizedText: mutatedText,
    };
    // Units no longer match text → TEXT_MISMATCH on build. Use empty units and
    // both representations as unreferenced context to isolate digest binding:
    // compare digests of two binding sets with same ids, different content hashes.
    const sameId = rep!.id;
    const left = computeIndexedRepresentationsSha256([
      {
        id: sameId,
        version: 1,
        sourceFileId: rep!.sourceFileId,
        normalizedTextSha256: sha256(rep!.normalizedText),
      },
    ]);
    const right = computeIndexedRepresentationsSha256([
      {
        id: sameId,
        version: 1,
        sourceFileId: rep!.sourceFileId,
        normalizedTextSha256: sha256(mutatedRep.normalizedText),
      },
    ]);
    expect(left).not.toBe(right);
  });

  it("rebuild after discard is byte-identical for the same input", async () => {
    const corpus = merge(guide(), other());
    const index = createLexicalIndex();
    const firstBuild = await index.build(SNAPSHOT_ID, corpus);
    expect(firstBuild.ok).toBe(true);
    const first = await searchOk(index, { query: "AUDIT_REQUIRED", limit: 10 });
    index.discard();
    const secondBuild = await index.build(SNAPSHOT_ID, corpus);
    expect(secondBuild.ok).toBe(true);
    const second = await searchOk(index, {
      query: "AUDIT_REQUIRED",
      limit: 10,
    });
    expect(first.selectedIds).toEqual(second.selectedIds);
    expect(first.receipt.indexedRepresentationsSha256).toBe(
      second.receipt.indexedRepresentationsSha256,
    );
    expect(first.receipt.indexVersion).toBe(second.receipt.indexVersion);
    expect(first.receipt.id).toBe(second.receipt.id);
  });

  it("input array order does not affect corpus digest or selection", async () => {
    const corpus = merge(guide(), other());
    const reversed: Corpus = {
      units: [...corpus.units].reverse(),
      files: [...corpus.files].reverse(),
      representations: [...corpus.representations].reverse(),
    };
    const left = await built(corpus);
    const right = await built(reversed);
    const a = await searchOk(left, { query: "Details", limit: 10 });
    const b = await searchOk(right, { query: "Details", limit: 10 });
    expect(a.receipt.indexedRepresentationsSha256).toBe(
      b.receipt.indexedRepresentationsSha256,
    );
    expect(a.selectedIds).toEqual(b.selectedIds);
  });
});

describe("immutability, purity, and no knowledge persistence", () => {
  it("freezes the search response and receipt arrays", async () => {
    const index = await built(guide());
    const response = await searchOk(index, { query: "source", limit: 5 });
    expectDeepFrozen(response);
    expectDeepFrozen(response.receipt);
    expectDeepFrozen(response.receipt.candidateIds);
    expectDeepFrozen(response.receipt.selectedIds);
    expectDeepFrozen(response.receipt.filters);
  });

  it("does not mutate caller input after build", async () => {
    // Unitizer may freeze its returned arrays; use mutable shells so the
    // post-build mutation probes copy-on-ingest rather than frozen fixtures.
    const base = guide();
    const corpus: Corpus = {
      units: [...base.units],
      files: [...base.files],
      representations: [...base.representations],
    };
    const unitCount = corpus.units.length;
    const index = createLexicalIndex();
    const result = await index.build(SNAPSHOT_ID, corpus);
    expect(result.ok).toBe(true);
    (corpus.units as SourceUnit[]).pop();
    expect(corpus.units.length).toBe(unitCount - 1);
    // Build must have copied; search still works against the pre-mutation corpus.
    const response = await searchOk(index, {
      query: "Deterministic",
      limit: 5,
    });
    expect(response.selectedIds.length).toBeGreaterThan(0);
  });

  it("receipt and response carry no source body text", async () => {
    const index = await built(guide());
    const response = await searchOk(index, {
      query: "AUDIT_REQUIRED",
      limit: 10,
    });
    const encoded = JSON.stringify(response);
    expect(encoded).not.toContain("Body mentions AUDIT_REQUIRED");
    expect(encoded).not.toContain("Accented body text");
    // No unit text digests leaked either (binding is representation-id digest only).
    for (const unit of guide().units) {
      expect(encoded).not.toContain(unit.textSha256);
    }
  });

  it("emits a strict portable SearchReceipt", async () => {
    const index = await built(guide());
    const response = await searchOk(index, { query: "Codes", limit: 5 });
    const parsed = SearchReceiptSchema.safeParse(response.receipt);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      parsed.data.selectedIds.every((id) =>
        parsed.data.candidateIds.includes(id),
      ),
    ).toBe(true);
  });
});

describe("bounds and limits", () => {
  it("returns QUERY_TOO_LONG with valid empty receipt and no search results", async () => {
    const index = await built(guide());
    const result = await index.search({
      query: "q".repeat(10_000),
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedIds).toEqual([]);
    expect(result.value.receipt.failures).toContain("QUERY_TOO_LONG");
    expect(SearchReceiptSchema.safeParse(result.value.receipt).success).toBe(
      true,
    );
    expect(JSON.stringify(result.value)).not.toContain(
      "Body mentions AUDIT_REQUIRED",
    );
  });

  it("honours a small limit", async () => {
    const index = await built(merge(guide(), other()));
    const response = await searchOk(index, { query: "body", limit: 1 });
    expect(response.selectedIds.length).toBeLessThanOrEqual(1);
    expect(response.receipt.selectedIds.length).toBeLessThanOrEqual(1);
  });
});

describe("strict search ingress", () => {
  it("does not execute hostile filter accessors and returns INVALID_REQUEST", async () => {
    const index = await built(guide());
    let accessed = false;
    const hostile = {
      query: "lexical",
      get filters() {
        accessed = true;
        throw new Error("accessor should not run");
      },
    };
    const result = await index.search(hostile as never);
    expect(accessed).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.failures).toContain("INVALID_REQUEST");
    expect(result.value.selectedIds).toEqual([]);
    expect(SearchReceiptSchema.safeParse(result.value.receipt).success).toBe(
      true,
    );
  });

  it("rejects unknown request keys without throwing", async () => {
    const index = await built(guide());
    const result = await index.search({
      query: "lexical",
      engine: "minisearch",
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.failures).toContain("INVALID_REQUEST");
    expect(result.value.selectedIds).toEqual([]);
  });

  it("rejects unknown filter keys including legacy status", async () => {
    const index = await built(guide());
    const result = await index.search({
      query: "Details",
      filters: { status: ["section"] } as never,
      limit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.failures).toContain("INVALID_REQUEST");
    expect(result.value.selectedIds).toEqual([]);
  });

  it("rejects non-plain request prototypes without throwing", async () => {
    const index = await built(guide());
    const result = await index.search(Object.create(null) as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.failures).toContain("INVALID_REQUEST");
  });

  it("rejects oversized filter arrays without throwing", async () => {
    const index = await built(guide());
    const result = await index.search({
      query: "body",
      filters: { scope: Array.from({ length: 100 }, (_, i) => `p${i}`) },
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.failures).toContain("INVALID_REQUEST");
  });
});

describe("build snapshot binding", () => {
  it("rejects a malformed snapshot id", async () => {
    const index = createLexicalIndex();
    const result = await index.build("snap-not-hex" as SnapshotId, guide());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });

  it("rejects units whose snapshotId does not match the build snapshot", async () => {
    const corpus = guide();
    const index = createLexicalIndex();
    const otherSnap = `snap-${"c".repeat(64)}` as SnapshotId;
    const result = await index.build(otherSnap, corpus);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });
});

describe("receipt id binding", () => {
  it("is stable under equivalent filter order", async () => {
    const index = await built(guide());
    const a = await searchOk(index, {
      query: "Details",
      filters: {
        unitKinds: ["section", "paragraph"],
        scope: ["docs/guide.md"],
      },
      limit: 10,
    });
    const b = await searchOk(index, {
      query: "Details",
      filters: {
        unitKinds: ["paragraph", "section"],
        scope: ["docs/guide.md"],
      },
      limit: 10,
    });
    expect(a.receipt.id).toBe(b.receipt.id);
  });

  it("differs when limit differs for the same query", async () => {
    const index = await built(merge(guide(), other()));
    const wide = await searchOk(index, { query: "body", limit: 20 });
    const narrow = await searchOk(index, { query: "body", limit: 1 });
    if (wide.selectedIds.length > 1) {
      expect(wide.receipt.id).not.toBe(narrow.receipt.id);
    }
    expect(wide.receipt.selectedIds.length).toBeGreaterThanOrEqual(
      narrow.receipt.selectedIds.length,
    );
  });

  it("receiptIdFor includes corpus digest and result sets", () => {
    const base = {
      snapshotId: SNAPSHOT_ID,
      indexVersion: "lexical-v1",
      corpusDigest: "a".repeat(64),
      query: "q",
      filters: {},
      limit: 5,
      failures: [] as string[],
      candidateIds: [] as never[],
      selectedIds: [] as never[],
    };
    const left = receiptIdFor(base);
    const right = receiptIdFor({
      ...base,
      corpusDigest: "b".repeat(64),
    });
    expect(left).not.toBe(right);
    expect(left).toMatch(/^rcpt-[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("bounded corpus search", () => {
  it("searches a multi-file corpus without throwing and stays deterministic", async () => {
    const parts = [guide(), other()];
    const corpus = merge(...parts);
    const index = await built(corpus);
    const first = await searchOk(index, { query: "body", limit: 50 });
    const second = await searchOk(index, { query: "body", limit: 50 });
    expect(first.selectedIds).toEqual(second.selectedIds);
    expect(first.receipt.id).toBe(second.receipt.id);
    expect(first.hits.length).toBeLessThanOrEqual(50);
  });
});
