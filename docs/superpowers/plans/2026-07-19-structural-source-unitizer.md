# Structural Source Unitizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert a canonical A-tier representation and its matching eligible audit into stable, exact-locator structural source units with complete selected-text accounting.

**Architecture:** Strict domain schemas replace the SourceUnit placeholder. One deterministic unitizer qualifies SourceFile→representation→built-in audit provenance, dispatches to six bounded format adapters, constructs a preorder unit graph, composes only audited locators, derives canonical content/logical unit IDs, and fails atomically when selected text is uncovered or multiply selected.

**Tech Stack:** TypeScript 6, Zod 4, Node SHA-256, Vitest 4, existing ingestion public barrels and schema registry.

## Global Constraints

- Work only in `.worktrees/t-12-01` on `task/t-12-01-structural-unitizer`; do not change backlog state from the worktree.
- Follow `.codex/skills/tdd/SKILL.md`: one public-seam failing behaviour test, verify RED, minimum GREEN, then the next vertical slice.
- Limit tests/builds to two workers; never run concurrent full gates.
- Tests import public directory barrels. Do not test private helpers.
- Input is canonical `SourceFile`, `SourceRepresentation`, and matching claim-eligible built-in `RepresentationAudit`; rerun deterministic audit and require exact equality before parsing.
- Store snapshot/file/representation IDs as provenance; exclude them from unit identity.
- Unit identity uses logical path, occurrence-qualified structural anchor, kind, selected-text digest, and duplicate ordinal.
- Do not invent original coordinates; compose only existing audited locator boundaries.
- Document containers do not satisfy selected-text accounting. Every non-whitespace normalized UTF-16 position must belong to exactly one atomic section/paragraph/list/table/code unit.
- No partial success: qualification failure returns `AUDIT_REQUIRED`; structural/coverage/tree/identity failure returns `TEXT_DROPPED`.
- Successful output is strict-schema-valid, deterministic, preorder-sorted, and deeply frozen.
- Run `pnpm check`, 16-test bundle integration validator, preserved 223-file bundle validator, formatting, and `git diff --check` before handoff.

---

## File map

- Create `code/domain/ingest/source-unit.ts`: canonical SourceUnit types and strict schemas.
- Modify `code/domain/ingest/index.ts`: export canonical source-unit domain.
- Modify `code/domain/ingest/schemas.ts`: remove the SourceUnit placeholder export.
- Modify `code/domain/ingest/schema-registry.ts`: import/register canonical SourceUnit schema.
- Modify `code/domain/ingest/schema-registry.test.ts`: current v1/migration/strictness evidence through public barrel.
- Create `code/ingest/source/unitizer.ts`: qualification, adapters, locator composition, IDs, graph/coverage validation, freezing.
- Create `code/ingest/source/unitizer.test.ts`: public unit/security/stability tests.
- Modify `code/ingest/source/index.ts`: export unitizer.
- Create `code/integration/source-unitizer.integration.test.ts`: extraction→audit→unitization for all six kinds and retrieval-readiness evidence.
- Binding design: `docs/superpowers/specs/2026-07-19-structural-source-unitizer-design.md`.

---

### Task 1: Replace the SourceUnit placeholder with the canonical domain contract

**Files:**

- Create: `code/domain/ingest/source-unit.ts`
- Modify: `code/domain/ingest/index.ts`
- Modify: `code/domain/ingest/schemas.ts`
- Modify: `code/domain/ingest/schema-registry.ts`
- Test: `code/domain/ingest/schema-registry.test.ts`

**Interfaces:**

- Consumes existing `SnapshotId`, `SourceFileId`, `SourceRepresentationId`, `SourceUnitId`, `Sha256` and their schemas.
- Produces `SourceUnitKind`, `SourceUnit`, `SourceUnitLocatorSchema`, `SourceUnitOriginalLocatorSchema`, `SourceUnitSchema`.

- [ ] **Step 1: Add one failing current-v1 registry test**

Add to `schema-registry.test.ts`, importing from `./index.js`:

```ts
it("registers the complete canonical SourceUnit schema", () => {
  const unit = {
    schemaVersion: 1,
    id: "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    snapshotId: `snap-${"b".repeat(64)}`,
    sourceFileId: `file-${"a".repeat(64)}`,
    representationId: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "paragraph",
    parentId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA",
    headingPath: ["Install"],
    normalizedLocator: {
      utf16Start: 10,
      utf16End: 20,
      lineStart: 3,
      columnStart: 1,
      lineEnd: 3,
      columnEnd: 11,
    },
    originalLocator: {
      byteStart: 12,
      byteEnd: 22,
      lineStart: 3,
      columnStart: 1,
      lineEnd: 3,
      columnEnd: 11,
    },
    textSha256: "c".repeat(64),
  } as const;
  expect(ingestSchemaRegistry.get("SourceUnit", 1).parse(unit)).toEqual(unit);
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run code/domain/ingest/schema-registry.test.ts -t "complete canonical SourceUnit" --maxWorkers=2
```

Expected: FAIL because the current placeholder rejects all required fields.

- [ ] **Step 3: Create strict nested locator and SourceUnit schemas**

Create `source-unit.ts` with explicit readonly interfaces and Zod schemas. Use `.safe().int()` on every numeric field. Add `.superRefine()` to both locator schemas:

```ts
if (value.utf16Start > value.utf16End)
  issue("utf16Start must not exceed utf16End");
if (
  value.lineStart > value.lineEnd ||
  (value.lineStart === value.lineEnd && value.columnStart > value.columnEnd)
)
  issue("start position must not follow end position");
```

For original locators apply the same rule to bytes and line/column. Use `z.enum(["document","section","paragraph","list","table","code"])`, strict parent ID optional, `z.array(z.string().min(1))`, and strict lowercase SHA-256.

- [ ] **Step 4: Replace—not duplicate—the placeholder**

Export `source-unit.ts` from the domain barrel. Remove only the placeholder `SourceUnitSchema` declaration from `schemas.ts`. Import `SourceUnitSchema` directly into `schema-registry.ts`; retain the same registry key/version.

- [ ] **Step 5: Add strict migration/security cases**

Add cases that reject `{schemaVersion:1,id}`, schemaVersion 0/missing, extra top/nested fields, malformed IDs/hash, unsafe/negative/inverted offsets, empty heading entries, and `parentId === id`. Enforce self-parent rejection in `SourceUnitSchema.superRefine()`.

- [ ] **Step 6: Run domain GREEN and static checks**

```bash
pnpm exec vitest run code/domain/ingest/schema-registry.test.ts --maxWorkers=2
pnpm typecheck
pnpm exec eslint code/domain/ingest/source-unit.ts code/domain/ingest/schema-registry.ts code/domain/ingest/schema-registry.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add code/domain/ingest/source-unit.ts code/domain/ingest/index.ts \
  code/domain/ingest/schemas.ts code/domain/ingest/schema-registry.ts \
  code/domain/ingest/schema-registry.test.ts
git commit -m "feat(ingest): define structural source units"
```

---

### Task 2: Qualification, deterministic identity, and empty-document slice

**Files:**

- Create: `code/ingest/source/unitizer.ts`
- Create: `code/ingest/source/unitizer.test.ts`
- Modify: `code/ingest/source/index.ts`

**Interfaces:**

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

- [ ] **Step 1: Write a failing zero-byte document test through `./index.js`**

Construct canonical zero-byte text SourceFile, empty representation, and exact built-in `a-tier:text` eligible audit. Assert one literal document unit with zero locators, empty heading path, exact SHA-256 of empty text, schema-valid ID, no parent, and all provenance. Assert the array/unit/nested locators/heading path are frozen.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run code/ingest/source/unitizer.test.ts -t "zero-byte document" --maxWorkers=2
```

Expected: public `unitizeRepresentation` missing.

- [ ] **Step 3: Implement canonical input qualification**

Plain-record preflight the known input graph, strict-parse all records, then verify file↔representation ID, audit↔representation ID, exact `capabilityFor(kind)` ID/version, Tier A, both passes and eligibility. Rerun public deterministic `auditRepresentation(representation)` and require its successful value to deep-equal the supplied audit; this catches post-audit text/locator mutation even though audit v1 has no content digest. Return deterministic `AUDIT_REQUIRED` errors without source text. Do not trust caller-supplied Tier A capability.

- [ ] **Step 4: Implement deterministic ID primitives**

Implement module-private:

```ts
function textSha256(text: string): Sha256;
function canonicalIdentityKey(input: {
  logicalPath: string;
  anchor: readonly { heading: string; occurrence: number }[];
  kind: SourceUnitKind;
  textSha256: Sha256;
  duplicateOrdinal: number;
}): string;
function unitIdFor(key: string): SourceUnitId;
```

`canonicalIdentityKey` uses `JSON.stringify()` on a newly constructed fixed-order object. `unitIdFor` hashes UTF-8 key with SHA-256, reads the first 16 bytes as 128 bits, and emits exactly 26 Crockford characters using the alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, padding the two high ULID-width bits with zero. Prefix `unit-`; strict-parse with `SourceUnitIdSchema` before use.

Add a literal expected ID generated independently with a short Python/Node fixture calculation, not by calling production helpers.

- [ ] **Step 5: Return and freeze the empty document**

Only accept the zero-length special case when file size, normalized text, and locator map are all zero. Its normalized/original location is offset 0 line/column 1. Derive its ID from logical path, empty anchor, document kind, empty digest, ordinal 1. Strict-parse the complete unit and deeply freeze output.

- [ ] **Step 6: Add qualification RED/GREEN cases one at a time**

For each case write the test, verify it fails if not already covered, then implement minimum behaviour:

- sourceFile ID mismatch;
- audit representation ID mismatch;
- ineligible/C/D audit;
- arbitrary eligible custom Tier A capability;
- malformed/prototype-shaped top-level and nested input;
- non-empty file with empty/unmappable representation.

Expected `AUDIT_REQUIRED` for qualification/binding cases; `TEXT_DROPPED` for non-empty unmappable input.

- [ ] **Step 7: Run and commit**

```bash
pnpm exec vitest run code/ingest/source/unitizer.test.ts --maxWorkers=2
pnpm typecheck
pnpm exec eslint code/ingest/source/unitizer.ts code/ingest/source/unitizer.test.ts
git add code/ingest/source/unitizer.ts code/ingest/source/unitizer.test.ts code/ingest/source/index.ts
git commit -m "feat(ingest): qualify structural unitization"
```

---

### Task 3: Text, code/config, and CSV adapters

**Files:**

- Modify: `code/ingest/source/unitizer.ts`
- Modify: `code/ingest/source/unitizer.test.ts`

**Interfaces:**

- Consumes qualified canonical inputs from Task 2.
- Produces document + atomic paragraph/code/table units with exact composed locators and accounting.

- [ ] **Step 1: Add a literal plain-text paragraph RED**

Use normalized text `"Alpha line\ncontinued\n\nBeta\n"` with four audited line locators. Assert preorder document, first paragraph (two lines), second paragraph, exact IDs/hashes/locators, document parents and empty heading paths.

Run targeted test; expected current `TEXT_DROPPED`/missing units.

- [ ] **Step 2: Implement locator composition and text grouping**

Create a module-private draft type carrying `kind`, human heading path, internal qualified anchor, locator-index range, parent draft key, selected normalized range, and duplicate ordinal. Group consecutive non-blank line locators into paragraph drafts. Compose first/last normalized/original boundaries. Document spans first/last representation locators. Verify each draft boundary equals audited locator boundaries.

- [ ] **Step 3: Implement selected-text accounting**

Allocate `Uint8Array(normalizedText.length)`. Required positions are every non-whitespace UTF-16 code unit. For each atomic draft mark its entire range; if a required position is already marked, fail. Afterward fail if any required position unmarked. Document does not mark coverage. Whitespace inside atomic ranges is allowed and marked but not required.

- [ ] **Step 4: Add whitespace-only and unrelated-edit stability cases**

A non-empty whitespace-only text representation yields only a document spanning locators. Insert an unrelated different-content paragraph before `Beta`; compare units by kind/text hash and assert unchanged IDs for Alpha/Beta. Editing Beta changes only Beta and document IDs.

- [ ] **Step 5: Add code/JSON/YAML RED/GREEN matrix**

For each kind, assert one code child spanning all audited lines under the document. Do not parse syntax. Run each test before adding kind routing. Whitespace-only config produces only document.

- [ ] **Step 6: Add CSV RED/GREEN**

Use committed simple and quoted-multiline CSV representations. Assert one table child spanning first through last cell and including delimiters/newlines between. Exact original range comes from first/last audited cell. Empty zero-byte CSV uses empty-document slice. A non-empty CSV with no cells fails.

- [ ] **Step 7: Add overlap/gap/bounds security cases**

Mutate qualified-looking input only where schemas allow: reordered locators, missing last locator, overlapping range, and normalized content not represented. Because its old audit no longer truthfully matches the mutated representation, qualification/audit consistency should fail `AUDIT_REQUIRED` where caught; exact unitization impossibility after canonical qualification fails `TEXT_DROPPED`. Do not mutate and reuse an audit if the mutation invalidates its canonical schema.

- [ ] **Step 8: Run and commit**

```bash
pnpm exec vitest run code/ingest/source/unitizer.test.ts --maxWorkers=2
pnpm typecheck
pnpm exec eslint code/ingest/source/unitizer.ts code/ingest/source/unitizer.test.ts
git add code/ingest/source/unitizer.ts code/ingest/source/unitizer.test.ts
git commit -m "feat(ingest): unitize text and structured data"
```

---

### Task 4: Markdown hierarchy and structural blocks

**Files:**

- Modify: `code/ingest/source/unitizer.ts`
- Modify: `code/ingest/source/unitizer.test.ts`
- Create: `code/ingest/source/fixtures/unitization/markdown-structure.md`
- Create: `code/ingest/source/fixtures/unitization/markdown-structure.expected.json`

**Interfaces:**

- Produces document/section/paragraph/list/table/code preorder from audited Markdown line locators.

- [ ] **Step 1: Commit an independently-authored Markdown fixture and expected literal graph**

Fixture must include: preamble paragraph; H1; multiline paragraph; list with indented continuation; GFM table; fenced code; H3 depth jump; duplicate H2 heading twice with identical child text; trailing paragraph. Expected JSON lists kind, parent index, heading path, normalized/original locator literals, selected text digest, duplicate ordinal/qualified anchor inputs, and final literal IDs.

- [ ] **Step 2: Add one failing heading/paragraph test**

Extract/audit the fixture through public APIs, call unitizer, initially assert only document/H1/paragraph literal subset. Run RED.

- [ ] **Step 3: Implement iterative section stack and preorder construction**

Recognize ATX headings only with 1–6 `#` plus separation. Trim marker and optional closing marker. Maintain stack of `{depth,draft,headingPath,identityAnchor}`; pop while top depth >= new depth. Parent to deepest shallower section or document. Count same normalized heading text occurrences among siblings for qualified anchor. Emit section heading as atomic unit and container parent.

- [ ] **Step 4: Add nested/depth-jump/duplicate-heading tests**

Verify H3 after H1 attaches to H1 without fabricated H2. Duplicate sibling H2 sections have same human heading path text but distinct qualified-anchor occurrence and IDs; identical child paragraphs beneath them do not collide.

- [ ] **Step 5: Add list RED/GREEN**

Recognize consecutive unordered (`-`, `*`, `+`) or ordered (`1.`/`1)`) item lines and indented continuations. One group becomes one list. A marker-looking line without required separation remains paragraph text. Assert coverage includes markers/continuations.

- [ ] **Step 6: Add table RED/GREEN**

Recognize a pipe header only when immediately followed by a delimiter row whose cells match `:?-{3,}:?`. Group following pipe rows. A lone pipe row remains paragraph. Include delimiter row in selected range/accounting.

- [ ] **Step 7: Add fenced-code RED/GREEN**

Recognize backtick/tilde fence length ≥3, keep exact opening/closing lines and interior. Closing fence must use same character and at least opening length. Unclosed fence fails `TEXT_DROPPED`. Heading/list/table-looking content inside fence remains code.

- [ ] **Step 8: Complete literal golden assertion and determinism**

Compare full returned records to independently-authored expected JSON after injecting fixture-specific provenance IDs. Run twice and compare exact JSON bytes. Verify every unit/tree/schema/freeze invariant.

- [ ] **Step 9: Commit**

```bash
pnpm exec vitest run code/ingest/source/unitizer.test.ts --maxWorkers=2
pnpm typecheck
pnpm exec eslint code/ingest/source/unitizer.ts code/ingest/source/unitizer.test.ts
git add code/ingest/source/unitizer.ts code/ingest/source/unitizer.test.ts \
  code/ingest/source/fixtures/unitization
git commit -m "feat(ingest): parse Markdown source units"
```

---

### Task 5: Public all-format integration and retrieval readiness

**Files:**

- Create: `code/integration/source-unitizer.integration.test.ts`
- Modify: `code/domain/ingest/schema-registry.test.ts` only for uncovered migration behaviour.
- Modify: `code/ingest/source/unitizer.ts`/test only for test-first integration defects.

**Interfaces:**

- Consumes public extraction/audit/unitization barrels and committed T-11 fixtures.
- Produces exact stable SourceUnit arrays ready for T-12-02/T-12-03.

- [ ] **Step 1: Add all-six public integration RED**

For Markdown, text, code, JSON, YAML, CSV fixtures:

1. load exact bytes;
2. create canonical SourceFile;
3. extract twice;
4. audit twice;
5. unitize twice;
6. assert exact deep equality and strict SourceUnit schema for each unit;
7. assert every ID is unique and every parent precedes child;
8. assert output deeply frozen.

Run; expected any missing adapter/integration behavior to fail.

- [ ] **Step 2: Independently prove selected-text accounting**

In the integration test, classify atomic kinds (`section`, `paragraph`, `list`, `table`, `code`), create a test-only literal bitmap, and assert every non-whitespace normalized position is covered exactly once. Do not call or copy production accounting helpers. Assert document overlap does not count.

- [ ] **Step 3: Prove stability boundaries**

Use two independently extracted Markdown/text fixtures differing only by an inserted unrelated block. Compare `{kind,headingPath,textSha256}` keys and assert unaffected IDs equal. Assert edited text/moved heading IDs differ. Record old/new IDs explicitly so T-11-03/T-23 invalidation can consume them later; do not implement persistence.

- [ ] **Step 4: Add adversarial qualification/tree/identity cases**

Test prototype-shaped nested records, matching-ID but wrong built-in capability, representation text/locator mutation paired with its old otherwise-valid audit, duplicate derived identity scenario, self/dangling parent if a draft bug is injected through a real fixture pattern, huge heading depth count without recursion, and error messages not containing fixture source text.

No production test hook is allowed. Trigger collision/duplicates through real identical sibling content/anchors and verify ordinals prevent collision.

- [ ] **Step 5: Focused gates and commit**

```bash
pnpm exec vitest run \
  code/domain/ingest/schema-registry.test.ts \
  code/ingest/source/extractors.test.ts \
  code/ingest/source/representation-auditor.test.ts \
  code/ingest/source/unitizer.test.ts \
  code/integration/source-extractors.integration.test.ts \
  code/integration/representation-audit.integration.test.ts \
  code/integration/source-unitizer.integration.test.ts \
  --maxWorkers=2
pnpm typecheck
pnpm lint
git diff --check
git add code/integration/source-unitizer.integration.test.ts \
  code/domain/ingest/schema-registry.test.ts code/ingest/source/unitizer.ts \
  code/ingest/source/unitizer.test.ts
git commit -m "test(ingest): integrate structural unitization"
```

---

### Task 6: Independent review, fixes, and full verification

**Files:**

- Review exact base `6ee46ab` through final HEAD.
- Fix only named T-12-01 files unless a demonstrated canonical registry/barrel defect requires adjacent change.

- [ ] **Step 1: Self-review against the binding design**

```bash
git diff --stat 6ee46ab..HEAD
git diff --check 6ee46ab..HEAD
git diff --no-ext-diff --unified=80 6ee46ab..HEAD -- \
  code/domain/ingest code/ingest/source \
  code/integration/source-unitizer.integration.test.ts \
  docs/superpowers/specs/2026-07-19-structural-source-unitizer-design.md
```

Check: no provenance IDs in unit identity; exact built-in audit binding; no invented original bytes; all six adapters; atomic-only accounting; no recursive heading parser; IDs canonical/unique; tree preorder and heading paths; no partial results; strict schema/output freeze; no source-text leakage.

- [ ] **Step 2: Run independent Standards and Spec reviewers in parallel**

Pin both to exact base/head. Standards sources: root/repo AGENTS, CONTEXT, TDD seams, ADR 0001/0005, smell baseline. Spec sources: binding design, backlog T-12-01, r0-r1 task, source-bundle SourceUnit/structural-unit requirements. Require PASS/FAIL and adversarial focus on identity stability, duplicate headings, coverage, locator honesty, qualification, empty/whitespace inputs, parser bounds. No reviewer edits/delegation/attn.

- [ ] **Step 3: Fix every meaningful finding test-first and rereview**

For each defect, add an exact public RED, run it, implement one root-cause fix, run focused GREEN. Repeat both reviews at the amended exact SHA until Standards and Spec PASS or report a genuine user-level contradiction.

- [ ] **Step 4: Run final full gates**

```bash
pnpm check
pnpm exec vitest run code/integration/ingest-bundle-validator.test.ts --maxWorkers=2
python docs/specs/automatic-ingestion-v3/source-bundle/tools/validate_bundle.py
pnpm exec prettier --check \
  code/domain/ingest/source-unit.ts code/domain/ingest/index.ts \
  code/domain/ingest/schemas.ts code/domain/ingest/schema-registry.ts \
  code/domain/ingest/schema-registry.test.ts \
  code/ingest/source/unitizer.ts code/ingest/source/unitizer.test.ts \
  code/ingest/source/index.ts code/integration/source-unitizer.integration.test.ts \
  docs/superpowers/specs/2026-07-19-structural-source-unitizer-design.md \
  docs/superpowers/plans/2026-07-19-structural-source-unitizer.md
git diff --check 6ee46ab..HEAD
git status --short
```

Expected: all static/tests/integrity/build gates pass, bundle integration 16/16, preserved validator `OK: validated 223 files`, formatting/diff clean, worktree clean.

- [ ] **Step 5: Report handoff without merging**

Return final SHA; RED/GREEN evidence per vertical slice; focused/full counts; both review verdicts; full gate evidence; conservative identity limitations (identical sibling insertion may renumber duplicate set); unresolved concerns. Coordinator merges locally, verifies merged main, marks backlog done, updates durable ledger, inspects ignored/untracked worktree contents, then cleans.

--- SUMMARY ---

- Replace the SourceUnit placeholder with strict versioned records and migration/security tests.
- Qualify exact SourceFile→representation→built-in eligible audit provenance before parsing; fail atomically on mismatch.
- Build stable canonical unit IDs from logical path, occurrence-qualified structural anchor, kind, selected-text digest, and duplicate ordinal—never snapshot/file/representation content addresses.
- Implement bounded adapters for Markdown, text, code, JSON, YAML, and CSV with exact locator composition, preorder parent/heading relations, and deep-frozen output.
- Enforce decisive atomic selected-text accounting so every non-whitespace semantic position is covered exactly once and containers cannot hide omissions.
- Prove all-format public integration, unaffected-unit stability, changed-unit invalidation boundaries, schema/tree/security invariants, independent Standards/Spec PASS, and complete repository/bundle gates before integration.
