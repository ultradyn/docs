# T-12-01 Structural Source Unitizer Design

## Purpose

T-12-01 turns a claim-eligible qualified representation into stable structural source units for later exact maps, lexical retrieval, evidence references, and coverage accounting. The deterministic unitizer owns parsing, IDs, parent/heading relationships, locator composition, and complete selected-text accounting. It never asks an agent to infer structure and never invents original coordinates that are absent from the audited representation.

## Binding decisions

- The unitizer consumes the canonical `SourceFile`, `SourceRepresentation`, and matching claim-eligible `RepresentationAudit`.
- Snapshot/file/representation IDs are stored as provenance but excluded from unit identity because they are content-addressed and would churn every unit after an unrelated edit.
- Unit identity derives from canonical logical path, structural anchor, unit kind, selected-text digest, and duplicate ordinal among otherwise identical siblings.
- Editing selected text or moving a unit to a different heading/structural anchor changes its ID. Downstream invalidation handles the old ID explicitly; the unitizer never silently redirects it.
- Inserting unrelated, different-content material preserves unaffected unit IDs. Inserting an identical sibling before an existing byte-identical sibling may renumber that duplicate set; this is the explicit “where possible” limit without a persistent lineage contract.
- Implement deterministic format adapters for all six existing A-tier kinds. Do not build a general syntax-tree framework or language-specific semantic parsers.
- Unitization depends on representation audit T-11-02, not repair T-11-03.

## Canonical domain record

Create `code/domain/ingest/source-unit.ts` and replace the placeholder `SourceUnitSchema` in `schemas.ts` with this canonical strict schema.

```ts
export type SourceUnitKind =
  "document" | "section" | "paragraph" | "list" | "table" | "code";

export interface SourceUnitLocator {
  readonly utf16Start: number;
  readonly utf16End: number;
  readonly lineStart: number;
  readonly columnStart: number;
  readonly lineEnd: number;
  readonly columnEnd: number;
}

export interface SourceUnitOriginalLocator {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly columnStart: number;
  readonly lineEnd: number;
  readonly columnEnd: number;
}

export interface SourceUnit {
  readonly schemaVersion: 1;
  readonly id: SourceUnitId;
  readonly snapshotId: SnapshotId;
  readonly sourceFileId: SourceFileId;
  readonly representationId: SourceRepresentationId;
  readonly kind: SourceUnitKind;
  readonly parentId?: SourceUnitId;
  readonly headingPath: readonly string[];
  readonly normalizedLocator: SourceUnitLocator;
  readonly originalLocator: SourceUnitOriginalLocator;
  readonly textSha256: Sha256;
}
```

All IDs use existing canonical schemas. Arrays and nested locators are deeply frozen in successful output. The schema is strict, requires positive safe-integer lines/columns, non-negative safe-integer offsets, non-inverted ranges, and canonical lowercase SHA-256. It cannot prove parent existence in one record; the unitizer validates tree-wide relations before returning.

The canonical ingest schema registry continues to expose `SourceUnit` version 1, but now points at the complete schema rather than the `{schemaVersion,id}` placeholder. Migration tests accept current v1 and reject legacy/missing/extra fields.

## Public unitizer boundary

Create `code/ingest/source/unitizer.ts` and export it through `code/ingest/source/index.ts`.

```ts
export interface UnitizeRepresentationInput {
  readonly sourceFile: SourceFile;
  readonly representation: SourceRepresentation;
  readonly audit: RepresentationAudit;
}

export function unitizeRepresentation(
  input: UnitizeRepresentationInput,
): IngestResult<readonly SourceUnit[], "AUDIT_REQUIRED" | "TEXT_DROPPED">;
```

The unitizer has no filesystem, Git, clock, random, provider, or agent dependency.

## Input qualification

Before parsing, the unitizer strict-parses all three records and verifies:

- `sourceFile.id === representation.sourceFileId`;
- `audit.representationId === representation.id`;
- audit tier is `A`, `claimEligible === true`, both structural/mapping checks pass, and the audit itself is policy-consistent;
- the audit capability reference exactly matches the immutable built-in capability ID/version for the representation kind; an arbitrary schema-valid Tier A capability is not authority;
- a fresh deterministic `auditRepresentation(representation)` result exactly equals the supplied audit, rebinding the current representation view despite T-11-02 audit records not containing a representation-content digest;
- representation kind is one of the six supported built-ins;
- input objects and nested arrays/records are plain canonical data rather than prototype-inherited records.

Any failure returns `AUDIT_REQUIRED` without partial units. The message names the failed binding/check but contains no source text.

## Structural model

### Document root

Every non-empty qualified representation produces one `document` root. Its normalized range/hash covers the complete normalized representation, including leading/trailing separators. Its original locator composes the first/last audited original boundaries only; SourceUnit v1 cannot honestly extend original line/column coordinates across trailing separators not covered by an extractor locator, because unitization does not receive original bytes. It is a container and does not participate in selected-text accounting. This also gives a whitespace-only non-empty representation an honest document locator even though it has no atomic selected units.

A genuinely empty source (`sourceFile.size === 0`, empty normalized text, empty locator map) produces one zero-length document unit at normalized/original offset 0, line 1, column 1. A non-empty source with empty normalized text or no usable locator cannot have a claim-eligible fresh audit and therefore fails `AUDIT_REQUIRED` at qualification before structural parsing.

### Markdown adapter

The Markdown adapter performs one bounded line-oriented pass over audited line locators and emits:

- `section`: one heading line (`#{1,6}` followed by separation), nested by heading depth;
- `code`: a complete fenced code block including opening/closing fences; unclosed fences fail `TEXT_DROPPED`;
- `table`: a GFM-style table group only when a header row is immediately followed by a valid delimiter row; subsequent pipe rows join the table;
- `list`: consecutive list-item lines plus their indented continuation lines;
- `paragraph`: consecutive remaining non-blank lines.

Section units represent heading text and also act as parents. Their locator covers only the heading line; child blocks keep their own ranges. Heading paths contain trimmed heading text without Markdown marker prefixes/suffixes. A heading-depth jump attaches to the deepest existing shallower section; missing intermediate depths are not fabricated.

Blank or whitespace-only lines are explicit non-selected separators. Other Markdown punctuation—including fences, table delimiters, list markers, thematic breaks, and HTML-looking text—is selected and must belong to an atomic unit.

### Text adapter

Plain text emits paragraph groups separated by blank/whitespace-only lines. Each paragraph is a child of the document root.

### Code/config adapters

`code`, `json`, and `yaml` each emit one `code` unit spanning all audited lines. The extractor has already validated JSON/YAML syntax; the unitizer does not add a second parser.

### CSV adapter

CSV emits one `table` unit spanning the first through last audited cell. The composed range includes serialized delimiters/newlines between those cells. Empty zero-byte CSV follows the empty-document rule.

## Atomic selection and accounting

Atomic selected units are:

- section heading lines;
- paragraphs;
- lists;
- tables;
- code units.

Document containers are excluded from accounting. Section headings are counted once through their section unit; section children do not overlap their heading.

The unitizer creates a coverage bitmap over normalized UTF-16 positions:

1. Mark every non-whitespace code unit in `normalizedText` as requiring coverage. Newlines and whitespace-only separator content do not require coverage.
2. For every atomic unit, mark its entire normalized range. Any required position already covered by another atomic unit is overlap and fails `TEXT_DROPPED`.
3. After all units, any required unmarked position fails `TEXT_DROPPED`.
4. Unit boundaries must align with audited locator boundaries; no arbitrary substring-to-original conversion is allowed.

This makes “no selected text silently dropped” decisive while allowing deterministic blank-line delimiters. Tests independently reconstruct required positions and compare literal coverage; they do not reuse production helpers.

## Locator composition

Each atomic unit is built from a contiguous sequence of existing audited locator spans.

- Normalized start/line/column come from the first locator.
- Normalized end/line/column come from the last locator.
- Original byte/line/column start and end come from the same first/last audited locators and must remain within `SourceFile.size`.
- The unitizer verifies locator order, contiguity modulo known delimiters, and representation bounds before composition.
- It never computes original bytes from normalized text.

Document original range composes the first and last audited representation locators; its normalized range is the explicit whole-representation exception. Section parenthood does not widen section locators over descendants. Empty source uses the explicit zero-length rule only when `sourceFile.size === 0`.

## Parent and heading relationships

- The document root has no `parentId` and an empty `headingPath`.
- Top-level sections have the document as parent.
- Nested sections have the nearest preceding shallower section as parent.
- Paragraph/list/table/code units have the current deepest section as parent, otherwise the document.
- A section’s `headingPath` includes itself and all ancestor headings.
- A block’s `headingPath` equals its parent section path.
- Every non-root parent must exist earlier in the returned deterministic preorder.
- Cycles, dangling parents, duplicate IDs, or a child whose heading path contradicts its parent fail `TEXT_DROPPED`.

## Stable deterministic identity

The unitizer computes canonical SHA-256 `textSha256` over the exact selected normalized substring.

The identity key is canonical UTF-8 JSON with fixed field order:

```json
{
  "logicalPath": "docs/guide.md",
  "anchor": [
    { "heading": "Install", "occurrence": 1 },
    { "heading": "Linux", "occurrence": 1 }
  ],
  "kind": "paragraph",
  "textSha256": "...",
  "duplicateOrdinal": 1
}
```

- `logicalPath` is the already-canonical `SourceFile.logicalPath`.
- `anchor` is an internal occurrence-qualified heading path, distinct from the human-readable `headingPath`. Every segment contains normalized heading text plus its ordinal among identical sibling headings. Section identity appends its own qualified segment; blocks use their parent section anchor; document anchor is empty. This prevents children beneath two identically named sibling sections from colliding.
- `duplicateOrdinal` is counted only among non-section units with otherwise identical identity keys under the same structural parent, so unrelated different-content insertions do not renumber units. Section duplicates are distinguished by the occurrence in their anchor.
- For every current adapter, the qualified `anchor` injectively determines the structural parent within one unitization result: document has no parent, a section anchor extends its parent anchor, and a block reuses its parent section anchor (or the empty document anchor). This is why `parentId` is not a separate identity-key field. Any future adapter must preserve this invariant or revise the identity contract; the tree-wide duplicate-ID guard remains fail-closed.

SHA-256 of this key is converted deterministically to `unit-` plus a 26-character Crockford Base32 payload from the first 128 digest bits. This satisfies the existing `SourceUnitIdSchema` without randomness. The encoder clears/uses the ULID-width top bits canonically and is tested against literal IDs computed independently by a fixture script. A duplicate derived ID or invalid schema output fails closed as `TEXT_DROPPED`.

The document unit includes the whole selected normalized text digest, so any semantic document edit changes the document ID. Unaffected atomic child IDs remain stable when their own key is unchanged.

## Error semantics

### `AUDIT_REQUIRED`

Used when canonical qualification cannot be established:

- malformed/non-plain source file, representation, or audit;
- source-file/representation/audit identity mismatch;
- non-A, non-eligible, failing, or inconsistent audit;
- unsupported representation kind/capability boundary.

### `TEXT_DROPPED`

Used when qualified input cannot be represented completely and exactly:

- malformed structural state such as unclosed Markdown fence after a fresh eligible audit;
- locator composition is impossible;
- required normalized text is uncovered or multiply selected;
- derived IDs collide or tree/schema invariants fail.

No partial output is returned.

## Security and bounded behaviour

- Strict schemas and explicit plain-record preflight reject inherited prototypes and extra fields.
- Parsing is iterative and linear in normalized text plus locator count.
- No recursion depends on heading depth; a bounded section stack handles nesting.
- Coverage allocation is bounded by extractor-capped normalized text.
- No caller-supplied identity function or executable adapter enters the boundary.
- Error messages exclude selected source text.
- Output is deterministic, schema-valid, deeply frozen, and independent of object insertion order.

## TDD surfaces

Tests exercise public barrels and use literal fixtures.

### Domain/migration

- Complete current v1 `SourceUnit` parses via the canonical registry.
- Legacy placeholder, missing, extra, unsafe, malformed hash/ID, inverted locator, and invalid parent shapes reject.

### Unit structure

- Markdown fixture yields literal document/section/nested-section/paragraph/list/table/code preorder with exact parent IDs, heading paths, locators, hashes, and IDs.
- Text yields paragraph groups.
- Code, JSON, and YAML yield code units.
- CSV yields a table unit with cell-composed coordinates.
- Empty zero-byte source yields the explicit zero-length document; non-empty unmappable source fails.

### Stability

- Inserting an unrelated different-content block preserves every unaffected atomic unit ID.
- Editing selected text changes that unit ID.
- Moving a unit under another heading changes its ID.
- Duplicate identical siblings receive distinct deterministic ordinals/IDs.
- Identically named sibling headings have distinct occurrence-qualified anchors, and their children cannot collide.

### Qualification/security

- Mismatched or ineligible audits return `AUDIT_REQUIRED`.
- Prototype-shaped inputs reject.
- Mutated locators, unclosed fences, overlap, missing selected characters, duplicate IDs, and invalid tree relations return `TEXT_DROPPED`.

### Integration/retrieval readiness

- Public extraction → audit → unitization runs twice identically on committed Markdown, text, code, JSON, YAML, and CSV fixtures.
- Every unit passes `SourceUnitSchema`.
- Independent selected-text accounting proves all non-whitespace semantic text is covered once by atomic units.
- Literal IDs and exact locators are suitable for T-12-02 maps and T-12-03 lexical index/search receipts.

## Out of scope

- Persisting source units or invalidation events;
- representation repair;
- exact maps/aliases;
- lexical indexing/search receipts;
- authority/lifecycle/coverage dispositions not yet present in source custody;
- Tier B/C rich-format adapters;
- language-aware source-code AST parsing;
- silent ID redirect or lineage tracking.
