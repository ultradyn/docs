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
import { auditRepresentation, unitizeRepresentation } from "../source/index.js";

import { ALIAS_CLASS_ORDER, buildExactMap, normalizeAlias } from "./index.js";

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
 * Builds a canonical markdown file/representation/unit triple by driving the
 * real unitizer, so unit identities and text digests are authentic rather than
 * hand-cast. Hand-built units would let a wrong digest pass unnoticed, which is
 * exactly what the rebinding checks below are meant to catch.
 */
function markdownFile(
  logicalPath: string,
  fileIdSeed: string,
  representationId: string,
  text: string,
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
    version: 1,
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
  "More body text.",
  "",
  "## Codes",
  "",
  "Codes E123 and HTTP-404 apply. The CPU and C++ are fine.",
  "",
  "## Café Ordering",
  "",
  "Accented body text.",
  "",
].join("\n");

const OTHER_TEXT = [
  "# Details",
  "",
  "Other body text.",
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

function built(corpus: Corpus) {
  const result = buildExactMap(corpus);
  if (!result.ok) throw new Error(`expected build to succeed: ${result.code}`);
  return result.value;
}

function unitOfKind(corpus: Corpus, kind: SourceUnit["kind"]): SourceUnit {
  const unit = corpus.units.find((candidate) => candidate.kind === kind);
  if (!unit) throw new Error(`no ${kind} unit in corpus`);
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

function sectionTitled(corpus: Corpus, heading: string): SourceUnit {
  const unit = corpus.units.find(
    (candidate) =>
      candidate.kind === "section" && candidate.headingPath.at(-1) === heading,
  );
  if (!unit) throw new Error(`no section titled ${heading}`);
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

describe("buildExactMap input validation", () => {
  it("rejects duplicate source unit identities rather than overwriting", () => {
    const corpus = guide();
    const duplicated = {
      ...corpus,
      units: [...corpus.units, corpus.units[0]!],
    };
    const result = buildExactMap(duplicated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DUPLICATE_UNIT");
  });

  it("rejects duplicate source file identities", () => {
    const corpus = guide();
    const duplicated = {
      ...corpus,
      files: [...corpus.files, corpus.files[0]!],
    };
    const result = buildExactMap(duplicated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DUPLICATE_CONTEXT");
  });

  it("rejects duplicate representation identities", () => {
    const corpus = guide();
    const duplicated = {
      ...corpus,
      representations: [...corpus.representations, corpus.representations[0]!],
    };
    const result = buildExactMap(duplicated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DUPLICATE_CONTEXT");
  });

  it("rejects a unit whose source file is absent from the context", () => {
    const corpus = guide();
    const result = buildExactMap({ ...corpus, files: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects a unit whose representation is absent from the context", () => {
    const corpus = guide();
    const result = buildExactMap({ ...corpus, representations: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects a representation that is bound to a different source file", () => {
    const corpus = merge(guide(), other());
    const [guideRepresentation, ...rest] = corpus.representations;
    const rebound: SourceRepresentation = {
      ...guideRepresentation!,
      sourceFileId: corpus.files[1]!.id,
    };
    const result = buildExactMap({
      ...corpus,
      representations: [rebound, ...rest],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects a unit whose selected text no longer matches its digest", () => {
    const corpus = guide();
    const [representation] = corpus.representations;
    const tampered: SourceRepresentation = {
      ...representation!,
      normalizedText: representation!.normalizedText.replace(
        "More body text.",
        "More body TEXT.",
      ),
    };
    const result = buildExactMap({
      ...corpus,
      representations: [tampered],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("TEXT_MISMATCH");
  });

  it("rejects a unit whose locator exceeds the normalized text", () => {
    const corpus = guide();
    const [representation] = corpus.representations;
    const truncated: SourceRepresentation = {
      ...representation!,
      normalizedText: representation!.normalizedText.slice(0, 10),
    };
    const result = buildExactMap({
      ...corpus,
      representations: [truncated],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("verifies the document unit against the whole normalized text", () => {
    // A document unit's digest covers the entire representation, not a locator
    // slice, so build must special-case it exactly as the unitizer does.
    const corpus = guide();
    const document = unitOfKind(corpus, "document");
    expect(document.textSha256).toBe(
      sha256(corpus.representations[0]!.normalizedText),
    );
    expect(built(corpus).lookup(document.id)).toEqual({
      kind: "unique",
      unit: document.id,
    });
  });

  it("accepts canonical context that is not referenced by any unit", () => {
    const corpus = guide();
    const spare = other();
    const result = buildExactMap({
      units: corpus.units,
      files: [...corpus.files, ...spare.files],
      representations: [...corpus.representations, ...spare.representations],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an empty corpus", () => {
    const result = buildExactMap({
      units: [],
      files: [],
      representations: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed unit record", () => {
    const corpus = guide();
    const malformed = [
      { ...corpus.units[0]!, kind: "chapter" },
    ] as unknown as readonly SourceUnit[];
    const result = buildExactMap({ ...corpus, units: malformed });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });

  it("rejects an input graph carrying non-plain prototypes or accessors", () => {
    const corpus = guide();
    const hostile = Object.create({ polluted: true }) as Record<
      string,
      unknown
    >;
    Object.assign(hostile, corpus.units[0]);
    const result = buildExactMap({
      ...corpus,
      units: [hostile] as unknown as readonly SourceUnit[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });
});

describe("exact map alias vocabulary", () => {
  it("resolves a unit by its literal identity", () => {
    const corpus = guide();
    const document = unitOfKind(corpus, "document");
    expect(built(corpus).lookup(document.id)).toEqual({
      kind: "unique",
      unit: document.id,
    });
  });

  it("resolves a logical path to that file's document unit", () => {
    const corpus = guide();
    const document = unitOfKind(corpus, "document");
    expect(built(corpus).lookup("docs/guide.md")).toEqual({
      kind: "unique",
      unit: document.id,
    });
  });

  it("resolves a section by its own heading", () => {
    const corpus = guide();
    const section = sectionTitled(corpus, "Deterministic Source Plane");
    expect(built(corpus).lookup("Deterministic Source Plane")).toEqual({
      kind: "unique",
      unit: section.id,
    });
  });

  it("resolves a section by its fully qualified heading path", () => {
    const corpus = merge(guide(), other());
    const section = sectionTitled(guide(), "Details");
    expect(built(corpus).lookup("Deterministic Source Plane/Details")).toEqual({
      kind: "unique",
      unit: section.id,
    });
  });

  it("resolves a multiword heading by its acronym", () => {
    const corpus = guide();
    const section = sectionTitled(corpus, "Deterministic Source Plane");
    expect(built(corpus).lookup("DSP")).toEqual({
      kind: "unique",
      unit: section.id,
    });
  });

  it("does not mint an acronym for a single-word heading", () => {
    const corpus = guide();
    const projection = built(corpus);
    const details = sectionTitled(corpus, "Details");
    const result = projection.lookup("D");
    expect(result.kind).toBe("missing");
    expect(projection.lookup("Details")).toEqual({
      kind: "unique",
      unit: details.id,
    });
  });

  it("resolves an underscore-separated error code from unit text", () => {
    const corpus = guide();
    expect(built(corpus).lookup("AUDIT_REQUIRED")).toEqual({
      kind: "unique",
      unit: paragraphUnder(corpus, "Deterministic Source Plane").id,
    });
  });

  it("resolves error codes carrying digits", () => {
    const corpus = guide();
    const projection = built(corpus);
    const codes = paragraphUnder(corpus, "Codes");
    expect(projection.lookup("E123")).toEqual({
      kind: "unique",
      unit: codes.id,
    });
    expect(projection.lookup("HTTP-404")).toEqual({
      kind: "unique",
      unit: codes.id,
    });
  });

  it("does not classify a plain uppercase word as an error code", () => {
    expect(built(guide()).lookup("CPU").kind).toBe("missing");
  });

  it("does not classify punctuation-bearing tokens as error codes", () => {
    expect(built(guide()).lookup("C++").kind).toBe("missing");
  });

  it("mints no error-code alias from the enclosing document unit", () => {
    // A document unit's selected text is the whole file, so minting codes from
    // it would make every error code ambiguous against its own block by
    // construction, and no error code could ever resolve uniquely.
    const corpus = guide();
    const result = built(corpus).lookup("AUDIT_REQUIRED");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    expect(result.unit).not.toBe(unitOfKind(corpus, "document").id);
  });

  it("mints no heading, title, or acronym alias for a block unit", () => {
    // Blocks inherit their section context but own no heading of their own.
    const corpus = guide();
    const projection = built(corpus);
    const details = sectionTitled(corpus, "Details");
    expect(projection.lookup("Details")).toEqual({
      kind: "unique",
      unit: details.id,
    });
    const plane = projection.lookup("Deterministic Source Plane");
    expect(plane).toEqual({
      kind: "unique",
      unit: sectionTitled(corpus, "Deterministic Source Plane").id,
    });
  });

  it("mints no heading or title alias for the document unit", () => {
    const corpus = guide();
    expect(built(corpus).lookup("guide").kind).toBe("missing");
  });

  it("returns missing for an alias no unit carries", () => {
    expect(built(guide()).lookup("no-such-alias")).toEqual({
      kind: "missing",
    });
  });

  it("returns missing for an alias that normalizes to nothing", () => {
    expect(built(guide()).lookup("   ---   ")).toEqual({ kind: "missing" });
  });
});

describe("exact map ambiguity", () => {
  it("retains every candidate when two files share a heading", () => {
    // guide.md's Details sits under a parent, so only its `heading` matches.
    // other.md's Details is at root, so its `title` and `heading` both
    // normalize to the same alias — one unit, two reasons, not two candidates.
    const corpus = merge(guide(), other());
    const nested = sectionTitled(guide(), "Details");
    const root = sectionTitled(other(), "Details");
    const result = built(corpus).lookup("Details");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect([...result.candidates]).toEqual([
      { unit: root.id, reason: "title" },
      ...[
        { unit: nested.id, reason: "heading" },
        { unit: root.id, reason: "heading" },
      ].sort((left, right) => (left.unit < right.unit ? -1 : 1)),
    ]);
    expect(new Set(result.candidates.map((entry) => entry.unit)).size).toBe(2);
  });

  it("classifies by distinct unit count, not by matching class count", () => {
    // other.md's root Details matches both `title` and `heading`, but it is
    // one unit, so the result must stay unique rather than becoming ambiguous.
    const corpus = other();
    expect(built(corpus).lookup("Details")).toEqual({
      kind: "unique",
      unit: sectionTitled(corpus, "Details").id,
    });
  });

  it("emits one deduplicated entry per unit and reason pair", () => {
    const corpus = merge(guide(), other());
    const result = built(corpus).lookup("Details");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    const keys = result.candidates.map(
      (entry) => `${entry.unit} ${entry.reason}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("retains candidates that collide across different alias classes", () => {
    const corpus = merge(guide(), other());
    const result = built(corpus).lookup("Audit Required");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    const reasons = result.candidates.map((candidate) => candidate.reason);
    expect(reasons).toContain("error-code");
    expect(reasons).toContain("heading");
  });

  it("labels every candidate with the alias class that matched", () => {
    const corpus = merge(guide(), other());
    const result = built(corpus).lookup("Details");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    for (const candidate of result.candidates) {
      expect(ALIAS_CLASS_ORDER).toContain(candidate.reason);
    }
  });

  it("sorts candidates by alias class then by unit identity", () => {
    const corpus = merge(guide(), other());
    const result = built(corpus).lookup("Audit Required");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    const ranked = result.candidates.map((candidate) => [
      ALIAS_CLASS_ORDER.indexOf(candidate.reason),
      candidate.unit,
    ]);
    expect(ranked).toEqual([...ranked].sort());
  });

  it("pins the alias class precedence", () => {
    expect(ALIAS_CLASS_ORDER).toEqual([
      "id",
      "path",
      "title",
      "heading",
      "acronym",
      "error-code",
    ]);
  });

  it("never reports a unique result when candidates collide", () => {
    const corpus = merge(guide(), other());
    expect(built(corpus).lookup("Details").kind).not.toBe("unique");
  });

  it("resolves an alias that collides only within one unit as unique", () => {
    const corpus = guide();
    const section = sectionTitled(corpus, "Deterministic Source Plane");
    const result = built(corpus).lookup("Deterministic Source Plane");
    expect(result).toEqual({ kind: "unique", unit: section.id });
  });
});

describe("alias normalization", () => {
  it("is case insensitive", () => {
    const projection = built(guide());
    expect(projection.lookup("deterministic source plane")).toEqual(
      projection.lookup("DETERMINISTIC SOURCE PLANE"),
    );
  });

  it("collapses every run of non-alphanumeric characters", () => {
    expect(normalizeAlias("Deterministic   Source---Plane")).toBe(
      normalizeAlias("Deterministic Source Plane"),
    );
  });

  it("trims leading and trailing separators", () => {
    expect(normalizeAlias("  --Details--  ")).toBe(normalizeAlias("Details"));
  });

  it("applies compatibility composition before folding", () => {
    expect(normalizeAlias("ﬁle")).toBe(normalizeAlias("file"));
  });

  it("retains non-ASCII letters and digits", () => {
    // An ASCII-only [^a-z0-9]+ separator rule would shred these into
    // "caf-ordering" and "-", so this pins the Unicode property escapes.
    expect(normalizeAlias("Café Ordering")).toBe("café-ordering");
    expect(normalizeAlias("Grüße")).toBe("grüße");
    expect(normalizeAlias("Ωmega")).toBe("ωmega");
    expect(normalizeAlias("٣٤٥")).toBe("٣٤٥");
  });

  it("folds case without locale sensitivity", () => {
    // A tr-TR locale lowercases "I" to a dotless i; the alias rule must not.
    expect(normalizeAlias("INDEX")).toBe("index");
    expect(normalizeAlias("Ingest")).toBe("ingest");
  });

  it("resolves a section whose heading carries accented letters", () => {
    const corpus = guide();
    expect(built(corpus).lookup("Café Ordering")).toEqual({
      kind: "unique",
      unit: sectionTitled(corpus, "Café Ordering").id,
    });
  });

  it("yields the empty string for an alias with no alphanumeric content", () => {
    expect(normalizeAlias(" --- ")).toBe("");
  });

  it("uses one rule at build time and at lookup time", () => {
    const projection = built(guide());
    expect(projection.lookup("docs/guide.md")).toEqual(
      projection.lookup("DOCS_GUIDE.MD"),
    );
  });
});

describe("exact map projection is disposable and deterministic", () => {
  it("serializes byte identically across repeated builds", () => {
    const corpus = merge(guide(), other());
    expect(built(corpus).serialize()).toBe(built(corpus).serialize());
  });

  it("serializes byte identically regardless of input order", () => {
    const corpus = merge(guide(), other());
    const reversed: Corpus = {
      units: [...corpus.units].reverse(),
      files: [...corpus.files].reverse(),
      representations: [...corpus.representations].reverse(),
    };
    expect(built(reversed).serialize()).toBe(built(corpus).serialize());
  });

  it("rebuilds byte identically after the projection is discarded", () => {
    const corpus = merge(guide(), other());
    const first = built(corpus).serialize();
    const second = built(corpus).serialize();
    expect(second).toBe(first);
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });

  it("emits canonical serialized key order", () => {
    const serialized = built(merge(guide(), other())).serialize();
    const keys = Object.keys(JSON.parse(serialized) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("exact map projection is immutable and pure", () => {
  it("returns a deeply frozen projection", () => {
    expectDeepFrozen(built(merge(guide(), other())));
  });

  it("ignores mutation of the input arrays after building", () => {
    const corpus = merge(guide(), other());
    const units = [...corpus.units];
    const projection = built({ ...corpus, units });
    const before = projection.serialize();
    units.length = 0;
    expect(projection.serialize()).toBe(before);
  });

  it("does not mutate the supplied canonical records", () => {
    const corpus = merge(guide(), other());
    const snapshot = structuredClone({
      units: corpus.units,
      files: corpus.files,
      representations: corpus.representations,
    });
    built(corpus);
    expect({
      units: corpus.units,
      files: corpus.files,
      representations: corpus.representations,
    }).toEqual(snapshot);
  });

  it("returns frozen candidate arrays from lookup", () => {
    const result = built(merge(guide(), other())).lookup("Details");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expectDeepFrozen(result.candidates);
  });
});

describe("exact map persists no knowledge", () => {
  it("stores no source text in the projection", () => {
    const serialized = built(merge(guide(), other())).serialize();
    expect(serialized).not.toContain("More body text.");
    expect(serialized).not.toContain("Other body text.");
  });

  it("stores no content digests in the projection", () => {
    const corpus = merge(guide(), other());
    const serialized = built(corpus).serialize();
    for (const unit of corpus.units) {
      expect(serialized).not.toContain(unit.textSha256);
    }
  });
});
