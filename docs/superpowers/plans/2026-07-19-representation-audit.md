# Representation Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, fail-closed representation auditor and capability registry that qualifies canonical A-tier extractor output while preventing Tier B/C/D or corrupted mappings from supporting claims.

**Architecture:** Domain-owned strict schemas define versioned capabilities, structured findings, and immutable audit records. A source-plane auditor resolves a readonly six-kind A-tier registry, independently checks locator structure and geometry in bounded passes, and derives policy booleans and eligibility; callers cannot supply outcomes. Invalid top-level representations return typed `INVALID_INPUT`, while capability/audit failures against a canonical representation return schema-valid ineligible audit records.

**Tech Stack:** TypeScript 6, Zod 4, Vitest 4, existing `IngestResult`/ingest schema registry, pnpm.

## Global Constraints

- Work only in `.worktrees/t-11-02` on `task/t-11-02-representation-audit`; do not edit backlog state from the worktree.
- Follow `.codex/skills/tdd/SKILL.md`: add one failing public-behaviour test, run RED, implement the minimum GREEN, then add the next slice.
- Limit Vitest to `--maxWorkers=2`; do not run concurrent full builds/tests.
- Keep the production surface deep: consumers import `code/domain/ingest/index.ts` and `code/ingest/source/index.ts`, not private helpers.
- The initial built-in registry supports only Markdown, text, code, JSON, YAML, and CSV as Tier A.
- Tier C stays representation-level ineligible; later named per-unit verification is outside this task.
- Tier D and unknown/malformed capability can never be claim-eligible.
- Audit records prove representation self-consistency, not original-byte fidelity.
- Capability input may select only the closed check vocabulary; it cannot execute callbacks or supply audit outcomes.
- Every successful return must pass the canonical strict `RepresentationAuditSchema`; no duplicate placeholder schema may remain.
- Keep findings deterministic, deduplicated, sorted, and free of raw source text.
- Run `pnpm check`, bundle integration validation, the preserved 223-file bundle validator, formatting, and `git diff --check` before handoff.

---

## File map

- Create `code/domain/ingest/representation-audit.ts`: capability/finding/audit types, strict Zod schemas, and cross-field policy invariants.
- Modify `code/domain/ingest/index.ts`: export the new domain module.
- Modify `code/domain/ingest/schema-registry.ts`: register the canonical `RepresentationAuditSchema`.
- Modify `code/domain/ingest/schema-registry.test.ts`: current-v1 and strict migration/negative coverage.
- Create `code/ingest/source/representation-auditor.ts`: readonly built-in registry, capability resolution, geometry checks, policy derivation, deterministic freeze.
- Create `code/ingest/source/representation-auditor.test.ts`: unit, security, determinism, and human-factor behaviour tests through public barrels.
- Modify `code/ingest/source/index.ts`: export the auditor public surface.
- Create `code/integration/representation-audit.integration.test.ts`: extraction-to-audit public-seam integration and post-extraction corruption rejection.
- Keep `docs/superpowers/specs/2026-07-19-representation-audit-design.md` as the binding design; amend only if implementation discovers a real contract contradiction.

---

### Task 1: Canonical representation-audit domain contract

**Files:**

- Create: `code/domain/ingest/representation-audit.ts`
- Modify: `code/domain/ingest/index.ts`
- Modify: `code/domain/ingest/schema-registry.ts`
- Test: `code/domain/ingest/schema-registry.test.ts`

**Interfaces:**

- Consumes: `SourceRepresentationId`, `SourceRepresentationKind`, Zod, and the existing closed `ingestSchemaRegistry`.
- Produces:

```ts
export type FormatTier = "A" | "B" | "C" | "D";
export type RepresentationAuditCheck = "structure" | "mapping" | "render";

export interface RepresentationCapability {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly representationKind: SourceRepresentationKind;
  readonly tier: FormatTier;
  readonly requiredChecks: readonly RepresentationAuditCheck[];
}

export type RepresentationCapabilityRef =
  | {
      readonly status: "resolved";
      readonly id: string;
      readonly version: number;
    }
  | { readonly status: "unresolved" };

export interface RepresentationAuditFinding {
  readonly code: RepresentationAuditFindingCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly locatorIndex?: number;
  readonly cell?: { readonly row: number; readonly column: number };
}

export interface RepresentationAudit {
  readonly schemaVersion: 1;
  readonly representationId: SourceRepresentationId;
  readonly capability: RepresentationCapabilityRef;
  readonly tier: FormatTier;
  readonly structuralPass: boolean;
  readonly mappingPass: boolean;
  readonly humanVerified: false;
  readonly claimEligible: boolean;
  readonly findings: readonly RepresentationAuditFinding[];
}
```

- Produces strict `RepresentationCapabilitySchema`, `RepresentationAuditFindingSchema`, and `RepresentationAuditSchema` exports.

- [ ] **Step 1: Add registry REDs for a strict v1 audit schema**

Append tests to `code/domain/ingest/schema-registry.test.ts` using the domain barrel:

```ts
it("registers the canonical strict RepresentationAudit schema", () => {
  const current = {
    schemaVersion: 1,
    representationId: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    capability: { status: "resolved", id: "a-tier:text", version: 1 },
    tier: "A",
    structuralPass: true,
    mappingPass: true,
    humanVerified: false,
    claimEligible: true,
    findings: [],
  };

  expect(
    ingestSchemaRegistry.get("RepresentationAudit", 1).parse(current),
  ).toEqual(current);
  expect(ingestSchemaRegistry.names()).toContain("RepresentationAudit");
  expect(
    ingestSchemaRegistry
      .get("RepresentationAudit", 1)
      .safeParse({ ...current, schemaVersion: 0 }).success,
  ).toBe(false);
  expect(
    ingestSchemaRegistry
      .get("RepresentationAudit", 1)
      .safeParse({ ...current, extra: true }).success,
  ).toBe(false);
});

it("rejects audit records whose policy fields contradict their findings", () => {
  const contradictory = {
    schemaVersion: 1,
    representationId: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    capability: { status: "unresolved" },
    tier: "D",
    structuralPass: true,
    mappingPass: true,
    humanVerified: false,
    claimEligible: true,
    findings: [
      {
        code: "INVALID_CAPABILITY",
        severity: "error",
        message: "Capability is invalid.",
      },
    ],
  };

  expect(
    ingestSchemaRegistry.get("RepresentationAudit", 1).safeParse(contradictory)
      .success,
  ).toBe(false);
});
```

Also import `RepresentationAuditSchema` and assert that legacy/missing fields, unsafe capability versions, duplicate/unsorted checks, non-false `humanVerified`, invalid IDs, unknown finding codes, and extra nested fields fail.

- [ ] **Step 2: Run the focused registry test and capture RED**

Run:

```bash
pnpm exec vitest run code/domain/ingest/schema-registry.test.ts --maxWorkers=2
```

Expected: FAIL because `RepresentationAudit` and its schemas are not exported or registered.

- [ ] **Step 3: Implement strict capability and finding schemas**

Create `code/domain/ingest/representation-audit.ts` with closed values and no free-form capability hooks:

```ts
import { z } from "zod";
import { SourceRepresentationIdSchema } from "./id-schemas.js";
import type {
  SourceRepresentation,
  SourceRepresentationKind,
} from "./representation-records.js";
import type { SourceRepresentationId } from "./types.js";

export const FormatTierSchema = z.enum(["A", "B", "C", "D"]);
export type FormatTier = z.infer<typeof FormatTierSchema>;

export const RepresentationAuditCheckSchema = z.enum([
  "structure",
  "mapping",
  "render",
]);
export type RepresentationAuditCheck = z.infer<
  typeof RepresentationAuditCheckSchema
>;

const RepresentationKindSchema = z.enum([
  "markdown",
  "text",
  "code",
  "json",
  "yaml",
  "csv",
]);

export const RepresentationCapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    version: z.number().safe().int().positive(),
    representationKind: RepresentationKindSchema,
    tier: FormatTierSchema,
    requiredChecks: z
      .array(RepresentationAuditCheckSchema)
      .min(1)
      .superRefine((checks, context) => {
        if (new Set(checks).size !== checks.length) {
          context.addIssue({
            code: "custom",
            message: "checks must be unique",
          });
        }
        const sorted = [...checks].sort();
        if (checks.some((check, index) => check !== sorted[index])) {
          context.addIssue({
            code: "custom",
            message: "checks must be sorted",
          });
        }
      }),
  })
  .strict();

export type RepresentationCapability = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly representationKind: SourceRepresentationKind;
  readonly tier: FormatTier;
  readonly requiredChecks: readonly RepresentationAuditCheck[];
};

export const RepresentationAuditFindingCodeSchema = z.enum([
  "INVALID_CAPABILITY",
  "CAPABILITY_KIND_MISMATCH",
  "CAPABILITY_VERSION_UNSUPPORTED",
  "CAPABILITY_CHECK_UNSUPPORTED",
  "TIER_REQUIRES_RENDER_AUDIT",
  "TIER_REQUIRES_UNIT_VERIFICATION",
  "TIER_UNSUPPORTED",
  "LOCATOR_MISSING",
  "LOCATOR_KIND_MISMATCH",
  "LOCATOR_INTERVAL_INVALID",
  "LOCATOR_OUT_OF_BOUNDS",
  "LOCATOR_ORDER_INVALID",
  "LOCATOR_OVERLAP",
  "LOCATOR_POSITION_MISMATCH",
  "ORIGINAL_POSITION_INVALID",
  "MAPPING_COVERAGE_GAP",
  "CSV_CELL_ORDER_INVALID",
]);
export type RepresentationAuditFindingCode = z.infer<
  typeof RepresentationAuditFindingCodeSchema
>;

export const RepresentationAuditFindingSchema = z
  .object({
    code: RepresentationAuditFindingCodeSchema,
    severity: z.enum(["error", "warning"]),
    message: z.string().min(1),
    locatorIndex: z.number().safe().int().nonnegative().optional(),
    cell: z
      .object({
        row: z.number().safe().int().positive(),
        column: z.number().safe().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
```

Use explicit readonly interfaces for exported domain records rather than leaking mutable Zod-inferred arrays.

- [ ] **Step 4: Implement the cross-field audit schema**

In the same file, define the capability reference and audit schema:

```ts
export const RepresentationCapabilityRefSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("resolved"),
        id: z.string().min(1),
        version: z.number().safe().int().positive(),
      })
      .strict(),
    z.object({ status: z.literal("unresolved") }).strict(),
  ],
);

const STRUCTURAL_CODES = new Set([
  "LOCATOR_MISSING",
  "LOCATOR_KIND_MISMATCH",
  "MAPPING_COVERAGE_GAP",
  "CSV_CELL_ORDER_INVALID",
]);
const MAPPING_CODES = new Set([
  "LOCATOR_INTERVAL_INVALID",
  "LOCATOR_OUT_OF_BOUNDS",
  "LOCATOR_ORDER_INVALID",
  "LOCATOR_OVERLAP",
  "LOCATOR_POSITION_MISMATCH",
  "ORIGINAL_POSITION_INVALID",
]);

export const RepresentationAuditSchema = z
  .object({
    schemaVersion: z.literal(1),
    representationId: SourceRepresentationIdSchema,
    capability: RepresentationCapabilityRefSchema,
    tier: FormatTierSchema,
    structuralPass: z.boolean(),
    mappingPass: z.boolean(),
    humanVerified: z.literal(false),
    claimEligible: z.boolean(),
    findings: z.array(RepresentationAuditFindingSchema),
  })
  .strict()
  .superRefine((audit, context) => {
    const errors = audit.findings.filter(
      (finding) => finding.severity === "error",
    );
    const structuralPass = !errors.some((finding) =>
      STRUCTURAL_CODES.has(finding.code),
    );
    const mappingPass = !errors.some((finding) =>
      MAPPING_CODES.has(finding.code),
    );
    if (audit.structuralPass !== structuralPass) {
      context.addIssue({
        code: "custom",
        path: ["structuralPass"],
        message: "must agree with structural findings",
      });
    }
    if (audit.mappingPass !== mappingPass) {
      context.addIssue({
        code: "custom",
        path: ["mappingPass"],
        message: "must agree with mapping findings",
      });
    }
    const eligible =
      audit.tier === "A" &&
      audit.capability.status === "resolved" &&
      structuralPass &&
      mappingPass &&
      errors.length === 0;
    if (audit.claimEligible !== eligible) {
      context.addIssue({
        code: "custom",
        path: ["claimEligible"],
        message: "must equal derived Tier A policy",
      });
    }
  });

export interface RepresentationAudit {
  readonly schemaVersion: 1;
  readonly representationId: SourceRepresentationId;
  readonly capability:
    | {
        readonly status: "resolved";
        readonly id: string;
        readonly version: number;
      }
    | { readonly status: "unresolved" };
  readonly tier: FormatTier;
  readonly structuralPass: boolean;
  readonly mappingPass: boolean;
  readonly humanVerified: false;
  readonly claimEligible: boolean;
  readonly findings: readonly RepresentationAuditFinding[];
}
```

Define `RepresentationAuditFinding` explicitly from the fields above. Keep the structural/mapping code sets exported only if the auditor needs them; otherwise leave them module-private.

- [ ] **Step 5: Export and register the canonical schema**

Add to `code/domain/ingest/index.ts`:

```ts
export * from "./representation-audit.js";
```

Import and add `RepresentationAudit: RepresentationAuditSchema` to the `schemas` object in `code/domain/ingest/schema-registry.ts`. Do not add a second placeholder to `schemas.ts`.

- [ ] **Step 6: Run focused tests and static checks**

Run:

```bash
pnpm exec vitest run code/domain/ingest/schema-registry.test.ts --maxWorkers=2
pnpm typecheck
pnpm exec eslint code/domain/ingest/representation-audit.ts code/domain/ingest/schema-registry.ts code/domain/ingest/schema-registry.test.ts
```

Expected: registry tests PASS; TypeScript and ESLint exit 0.

- [ ] **Step 7: Commit the domain contract**

```bash
git add code/domain/ingest/representation-audit.ts \
  code/domain/ingest/index.ts \
  code/domain/ingest/schema-registry.ts \
  code/domain/ingest/schema-registry.test.ts
git commit -m "feat(ingest): define representation audit records"
```

---

### Task 2: Built-in capability registry and fail-closed policy

**Files:**

- Create: `code/ingest/source/representation-auditor.ts`
- Create: `code/ingest/source/representation-auditor.test.ts`
- Modify: `code/ingest/source/index.ts`

**Interfaces:**

- Consumes: canonical `SourceRepresentation`, `SourceRepresentationSchema`, capability/audit schemas from Task 1.
- Produces:

```ts
export function capabilityFor(
  kind: SourceRepresentationKind,
): RepresentationCapability | undefined;

export function auditRepresentation(
  representation: unknown,
  capability?: unknown,
): IngestResult<RepresentationAudit, "INVALID_INPUT">;
```

- [ ] **Step 1: Write REDs for built-ins, invalid input, and tier policy**

Create `code/ingest/source/representation-auditor.test.ts`. Build one canonical text representation with the public domain types and assert:

```ts
import { describe, expect, it } from "vitest";
import type {
  SourceFileId,
  SourceRepresentation,
  SourceRepresentationId,
} from "../../domain/ingest/index.js";
import {
  RepresentationAuditSchema,
  type RepresentationCapability,
} from "../../domain/ingest/index.js";
import { auditRepresentation, capabilityFor } from "./index.js";

const representation: SourceRepresentation = {
  schemaVersion: 1,
  id: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId,
  sourceFileId: `file-${"a".repeat(64)}` as SourceFileId,
  version: 1,
  kind: "text",
  normalizedText: "alpha\nbeta\n",
  locatorMap: [
    {
      kind: "line",
      normalized: {
        utf16Start: 0,
        utf16End: 5,
        lineStart: 1,
        columnStart: 1,
        lineEnd: 1,
        columnEnd: 6,
      },
      original: {
        byteStart: 0,
        byteEnd: 5,
        lineStart: 1,
        columnStart: 1,
        lineEnd: 1,
        columnEnd: 6,
      },
    },
    {
      kind: "line",
      normalized: {
        utf16Start: 6,
        utf16End: 10,
        lineStart: 2,
        columnStart: 1,
        lineEnd: 2,
        columnEnd: 5,
      },
      original: {
        byteStart: 6,
        byteEnd: 10,
        lineStart: 2,
        columnStart: 1,
        lineEnd: 2,
        columnEnd: 5,
      },
    },
  ],
  warnings: [],
};

it("registers all and only the six built-in A-tier kinds", () => {
  for (const kind of [
    "markdown",
    "text",
    "code",
    "json",
    "yaml",
    "csv",
  ] as const) {
    expect(capabilityFor(kind)).toMatchObject({
      schemaVersion: 1,
      representationKind: kind,
      tier: "A",
      requiredChecks: ["mapping", "structure"],
    });
  }
  expect(capabilityFor("unknown" as "text")).toBeUndefined();
});

it("returns a canonical deterministic eligible audit for valid A-tier text", () => {
  const first = auditRepresentation(representation);
  const second = auditRepresentation(structuredClone(representation));
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    ok: true,
    value: {
      tier: "A",
      structuralPass: true,
      mappingPass: true,
      humanVerified: false,
      claimEligible: true,
      findings: [],
    },
  });
  if (first.ok)
    expect(RepresentationAuditSchema.parse(first.value)).toEqual(first.value);
});

it("returns INVALID_INPUT instead of minting an audit for an invalid representation ID", () => {
  expect(auditRepresentation({ ...representation, id: "not-an-id" })).toEqual({
    ok: false,
    code: "INVALID_INPUT",
    message: expect.stringContaining("representation"),
  });
});
```

Add table-driven custom capabilities for B/C/D and assert B emits `TIER_REQUIRES_RENDER_AUDIT`, C emits the exact phrase “named human verification per selected source unit”, and D emits `TIER_UNSUPPORTED`; all are ineligible and `humanVerified: false`. Add malformed, kind-mismatched, version-2, render-check, and extra-field capability cases; each must return a successful audit with a deterministic error finding, not throw.

- [ ] **Step 2: Run the auditor test and capture RED**

```bash
pnpm exec vitest run code/ingest/source/representation-auditor.test.ts --maxWorkers=2
```

Expected: FAIL because the source auditor public surface does not exist.

- [ ] **Step 3: Implement the readonly six-kind registry**

Create `code/ingest/source/representation-auditor.ts` with frozen constants:

```ts
const checks = Object.freeze(["mapping", "structure"] as const);

function builtIn(
  representationKind: SourceRepresentationKind,
): RepresentationCapability {
  return Object.freeze({
    schemaVersion: 1,
    id: `a-tier:${representationKind}`,
    version: 1,
    representationKind,
    tier: "A",
    requiredChecks: checks,
  });
}

const BUILT_INS: ReadonlyMap<
  SourceRepresentationKind,
  RepresentationCapability
> = new Map(
  (["markdown", "text", "code", "json", "yaml", "csv"] as const).map((kind) => [
    kind,
    builtIn(kind),
  ]),
);

export function capabilityFor(
  kind: SourceRepresentationKind,
): RepresentationCapability | undefined {
  return BUILT_INS.get(kind);
}
```

Do not export the mutable `Map`, and do not accept registry mutation.

- [ ] **Step 4: Implement capability resolution and tier findings**

Add a resolver that distinguishes malformed capability from a canonical one:

```ts
interface CapabilityResolution {
  readonly capabilityRef: RepresentationAudit["capability"];
  readonly tier: FormatTier;
  readonly capability?: RepresentationCapability;
  readonly findings: RepresentationAuditFinding[];
}
```

Rules:

- `capability === undefined`: use the built-in for the parsed representation kind; if absent, unresolved/D/`INVALID_CAPABILITY`.
- Failed `RepresentationCapabilitySchema.safeParse`: unresolved/D/`INVALID_CAPABILITY`.
- Parsed capability kind mismatch: resolved reference, declared tier, `CAPABILITY_KIND_MISMATCH`.
- Version other than 1: `CAPABILITY_VERSION_UNSUPPORTED`.
- Any `render` check: `CAPABILITY_CHECK_UNSUPPORTED`; Tier B additionally gets `TIER_REQUIRES_RENDER_AUDIT`.
- Tier C gets `TIER_REQUIRES_UNIT_VERIFICATION` with deterministic message: `Tier C requires named human verification per selected source unit.`
- Tier D gets `TIER_UNSUPPORTED`.
- Tier alone never removes a prior error.

- [ ] **Step 5: Add a minimal canonical audit builder**

Before geometry checks exist, make only the simple canonical fixture pass by adding check placeholders that inspect its exact shape rather than returning unconditional true. Build findings first, then derive booleans from the same finding-code sets used by the domain schema. Sort using a stable key:

```ts
function findingKey(finding: RepresentationAuditFinding): string {
  return [
    finding.code,
    String(finding.locatorIndex ?? -1).padStart(12, "0"),
    String(finding.cell?.row ?? -1).padStart(12, "0"),
    String(finding.cell?.column ?? -1).padStart(12, "0"),
    finding.message,
  ].join("\u0000");
}
```

Deduplicate by this key, derive `claimEligible` exactly as the schema does, parse with `RepresentationAuditSchema`, then deep-freeze nested capability/findings/cell arrays before returning `{ ok: true, value }`.

For invalid `SourceRepresentationSchema.safeParse`, return:

```ts
{
  ok: false,
  code: "INVALID_INPUT",
  message: `Invalid source representation: ${issues}`,
}
```

Do not include normalized/source text in the message.

- [ ] **Step 6: Export the auditor and run GREEN**

Add to `code/ingest/source/index.ts`:

```ts
export * from "./representation-auditor.js";
```

Run:

```bash
pnpm exec vitest run code/ingest/source/representation-auditor.test.ts --maxWorkers=2
pnpm typecheck
```

Expected: the initial registry/policy suite passes with no exceptions or schema-invalid records.

- [ ] **Step 7: Commit the capability/policy slice**

```bash
git add code/ingest/source/representation-auditor.ts \
  code/ingest/source/representation-auditor.test.ts \
  code/ingest/source/index.ts
git commit -m "feat(ingest): classify representation capability"
```

---

### Task 3: Independent locator structure and mapping audit

**Files:**

- Modify: `code/ingest/source/representation-auditor.ts`
- Modify: `code/ingest/source/representation-auditor.test.ts`

**Interfaces:**

- Consumes: canonical representations and resolved capability requirements from Task 2.
- Produces: bounded independent structure/mapping findings used to derive `structuralPass`, `mappingPass`, and Tier A eligibility.

- [ ] **Step 1: Add line-representation corruption REDs**

In `representation-auditor.test.ts`, add a `mutateLocator(index, patch)` helper that creates new objects without mutating the base fixture. Add separate tests for:

```ts
const corruptions = [
  [
    "reordered",
    { locatorMap: [...representation.locatorMap].reverse() },
    "LOCATOR_ORDER_INVALID",
  ],
  [
    "overlap",
    mutateLocator(1, { normalized: { utf16Start: 4 } }),
    "LOCATOR_OVERLAP",
  ],
  [
    "inverted",
    mutateLocator(0, { normalized: { utf16End: -1 } }),
    "INVALID_INPUT",
  ],
  [
    "out of bounds",
    mutateLocator(1, { normalized: { utf16End: 99 } }),
    "LOCATOR_OUT_OF_BOUNDS",
  ],
  [
    "forged column",
    mutateLocator(1, { normalized: { columnStart: 2 } }),
    "LOCATOR_POSITION_MISMATCH",
  ],
  [
    "dropped line",
    { ...representation, locatorMap: representation.locatorMap.slice(0, 1) },
    "MAPPING_COVERAGE_GAP",
  ],
];
```

Distinguish strict-schema failures (`INVALID_INPUT`, such as negative schema-forbidden values) from canonical-but-incoherent representations (successful ineligible audits with findings). Add non-ASCII UTF-16 text (`"😀x\né\n"`) and verify column recomputation counts UTF-16 code units. Add empty-text and internal-empty-line boundaries.

- [ ] **Step 2: Run the line corruption tests and capture RED**

```bash
pnpm exec vitest run code/ingest/source/representation-auditor.test.ts -t "reordered|overlap|bounds|column|coverage|UTF-16|empty" --maxWorkers=2
```

Expected: one or more canonical corruptions incorrectly remain eligible.

- [ ] **Step 3: Implement one-pass normalized coordinate tables**

Add module-private helpers:

```ts
interface NormalizedBoundary {
  readonly line: number;
  readonly column: number;
}

function normalizedBoundaries(text: string): readonly NormalizedBoundary[] {
  const boundaries = new Array<NormalizedBoundary>(text.length + 1);
  let line = 1;
  let column = 1;
  for (let offset = 0; offset <= text.length; offset += 1) {
    boundaries[offset] = { line, column };
    if (offset === text.length) break;
    if (text[offset] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return boundaries;
}

function normalizedLineRanges(
  text: string,
): readonly { start: number; end: number; line: number }[] {
  if (text.length === 0) return [];
  const ranges = [];
  let start = 0;
  let line = 1;
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] !== "\n") continue;
    ranges.push({ start, end: offset, line });
    start = offset + 1;
    line += 1;
  }
  if (start < text.length) ranges.push({ start, end: text.length, line });
  return ranges;
}
```

This counts JavaScript UTF-16 units by iterating string indices, matching the locator contract. A terminal newline does not create a phantom final locator; internal empty lines do create zero-width line ranges.

- [ ] **Step 4: Implement shared interval/order/position checks**

For every locator, check:

- safe-integer original and normalized coordinates;
- `start <= end` for normalized UTF-16 and original bytes;
- normalized end at most `normalizedText.length`;
- line/column boundaries equal `normalizedBoundaries[start/end]`;
- normalized sort order by `(utf16Start, utf16End)` and no overlap;
- original sort/no overlap by `(byteStart, byteEnd)`;
- original start position is not after original end position lexicographically.

Emit at most one instance of a code per locator/coordinate defect; do not emit unbounded duplicates for the same root cause. Preserve exact locator index.

- [ ] **Step 5: Implement non-CSV structural coverage**

For `markdown`, `text`, `code`, `json`, and `yaml`:

- require every locator kind to be `line` and `cell` to be absent;
- compare locator count and each normalized start/end/line against `normalizedLineRanges`;
- emit `LOCATOR_MISSING` for non-empty text with no locators;
- emit `MAPPING_COVERAGE_GAP` for dropped, extra, or misbound ranges;
- accept empty text with an empty map, but reject locators against empty text.

This verifies complete line geometry without re-parsing JSON/YAML semantics.

- [ ] **Step 6: Run line corruption GREEN**

```bash
pnpm exec vitest run code/ingest/source/representation-auditor.test.ts -t "reordered|overlap|bounds|column|coverage|UTF-16|empty" --maxWorkers=2
```

Expected: all selected line/mapping tests pass; every corrupted canonical record is ineligible.

- [ ] **Step 7: Add CSV corruption REDs using a real extracted fixture shape**

Add a valid CSV representation with `normalizedText: "a,b\n1,2\n"` and four exact cell locators. Add cases for:

- locator kind changed from `cell`;
- missing cell metadata;
- duplicate `(row,column)`;
- skipped row/column;
- reordered cells;
- dropped final cell;
- forged cell normalized span;
- a quoted multiline cell whose span crosses lines;
- empty CSV.

Expect the valid and multiline records to pass and every corruption to emit `CSV_CELL_ORDER_INVALID`, `LOCATOR_KIND_MISMATCH`, or `MAPPING_COVERAGE_GAP` and remain ineligible.

- [ ] **Step 8: Run CSV tests and capture RED**

```bash
pnpm exec vitest run code/ingest/source/representation-auditor.test.ts -t "CSV|csv|cell" --maxWorkers=2
```

Expected: dropped/forged CSV cell geometry is not yet detected.

- [ ] **Step 9: Implement bounded CSV geometry scanning**

Implement an independent iterative scanner over normalized CSV text that derives expected cell identities and raw normalized spans without deserialising values:

```ts
interface ExpectedCell {
  readonly row: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
}
```

State rules:

- comma ends an unquoted cell;
- LF ends an unquoted row;
- a quote at cell start enters quoted mode;
- doubled quotes inside quoted mode are consumed together;
- LF inside quoted mode remains part of the cell and does not increment CSV row;
- the closing quote remains in the normalized raw span because T-11-01 locators address the serialized CSV cell span;
- EOF closes the final cell only when content exists after the last delimiter/row ending;
- extractor-produced normalized CSV is already grammar-valid, so an impossible scanner state emits `MAPPING_COVERAGE_GAP` rather than throwing.

Compare the expected cell sequence to locator `cell`, normalized start/end, and row-major order. Keep the scanner O(normalized text length) and allocation O(cell count).

- [ ] **Step 10: Run the complete auditor suite**

```bash
pnpm exec vitest run code/ingest/source/representation-auditor.test.ts --maxWorkers=2
pnpm typecheck
pnpm exec eslint code/ingest/source/representation-auditor.ts code/ingest/source/representation-auditor.test.ts
```

Expected: all policy, structure, line mapping, CSV, security, and determinism tests pass.

- [ ] **Step 11: Commit the independent mapping audit**

```bash
git add code/ingest/source/representation-auditor.ts \
  code/ingest/source/representation-auditor.test.ts
git commit -m "feat(ingest): verify representation mappings"
```

---

### Task 4: Public extraction-to-audit integration and migration evidence

**Files:**

- Create: `code/integration/representation-audit.integration.test.ts`
- Modify: `code/domain/ingest/schema-registry.test.ts` only if Task 1 did not fully cover current/legacy schema behaviour.

**Interfaces:**

- Consumes: public `extractATier`, `auditRepresentation`, `RepresentationAuditSchema`, committed T-11-01 fixtures, and deterministic source/identity helpers.
- Produces: end-to-end evidence that canonical extraction is eligible, post-extraction corruption is independently rejected, and only current strict audit records enter the registry.

- [ ] **Step 1: Write the public-seam integration RED**

Create `code/integration/representation-audit.integration.test.ts`. Load `markdown-crlf.md` and `table-cr.csv`, derive their canonical `SourceFile` hashes and fixed representation IDs, and import production functions only from public barrels:

```ts
import {
  RepresentationAuditSchema,
  type Sha256,
  type SnapshotId,
  type SourceFile,
  type SourceFileId,
  type SourceRepresentationId,
} from "../domain/ingest/index.js";
import { auditRepresentation, extractATier } from "../ingest/source/index.js";
```

For each fixture:

1. extract twice and assert exact equality;
2. audit twice and assert exact equality;
3. assert the successful audit passes `RepresentationAuditSchema` and is Tier A/eligible;
4. clone the representation, reverse two locators without altering the ID, audit it, and assert ineligible plus `LOCATOR_ORDER_INVALID` or `CSV_CELL_ORDER_INVALID`;
5. assert the original extracted object and its nested arrays remain frozen/unchanged.

- [ ] **Step 2: Run integration test and capture RED or missing behaviour**

```bash
pnpm exec vitest run code/integration/representation-audit.integration.test.ts --maxWorkers=2
```

Expected before final fixes: FAIL if public exports, CSV geometry, deep freezing, or deterministic finding order is incomplete.

- [ ] **Step 3: Make the smallest production corrections required by integration**

Confine fixes to `representation-auditor.ts`, its test, or barrels. Do not modify extractor semantics merely to satisfy the auditor. If integration exposes a representation-contract ambiguity, update the design spec explicitly before changing behaviour.

The successful return must deep-freeze:

```ts
Object.freeze(audit.capability);
for (const finding of audit.findings) {
  if (finding.cell) Object.freeze(finding.cell);
  Object.freeze(finding);
}
Object.freeze(audit.findings);
Object.freeze(audit);
```

- [ ] **Step 4: Complete migration/strict registry tests**

Ensure `schema-registry.test.ts` separately rejects:

- `schemaVersion: 0` and missing `schemaVersion`;
- missing capability discriminator;
- resolved capability without ID/version;
- `humanVerified: true` in audit v1;
- Tier C/D with `claimEligible: true`;
- Tier A eligible with an error finding;
- unknown finding/check/tier;
- unsafe integers and extra nested fields.

No migration implementation is added; current v1 is accepted and unsupported legacy shapes are rejected.

- [ ] **Step 5: Run focused integration/domain/source gates**

```bash
pnpm exec vitest run \
  code/domain/ingest/schema-registry.test.ts \
  code/ingest/source/extractors.test.ts \
  code/ingest/source/representation-auditor.test.ts \
  code/integration/source-extractors.integration.test.ts \
  code/integration/source-representation.migration.test.ts \
  code/integration/representation-audit.integration.test.ts \
  --maxWorkers=2
```

Expected: all selected files and tests pass with zero failures.

- [ ] **Step 6: Commit integration evidence**

```bash
git add code/integration/representation-audit.integration.test.ts \
  code/domain/ingest/schema-registry.test.ts \
  code/ingest/source/representation-auditor.ts \
  code/ingest/source/representation-auditor.test.ts \
  code/ingest/source/index.ts
git commit -m "test(ingest): integrate representation audits"
```

---

### Task 5: Review, full verification, and handoff

**Files:**

- Review all changes from base `b42f0b8` through branch HEAD.
- Modify only files already named in this plan when correcting review findings; broaden scope only for a demonstrated canonical-schema integration defect.

**Interfaces:**

- Consumes: completed T-11-02 branch and binding design.
- Produces: review evidence, clean full gates, final commit SHA, and a clean worktree ready for coordinator merge/backlog closure.

- [ ] **Step 1: Self-review the exact diff against the design**

Run:

```bash
git diff --stat b42f0b8..HEAD
git diff --check b42f0b8..HEAD
git diff --no-ext-diff --unified=80 b42f0b8..HEAD -- \
  code/domain/ingest \
  code/ingest/source \
  code/integration/representation-audit.integration.test.ts \
  docs/superpowers/specs/2026-07-19-representation-audit-design.md
```

Verify line by line:

- capability does not contain callbacks/outcomes;
- audit eligibility is derived once from policy;
- Tier C wording says named per-selected-unit verification;
- Tier D never becomes eligible;
- malformed top-level representation returns `INVALID_INPUT`;
- malformed capability produces unresolved/D audit rather than fabricated provenance;
- every successful return passes `RepresentationAuditSchema`;
- finding output is bounded, deterministic, and contains no source text;
- no original-byte fidelity claim is made;
- all loops are linear/bounded and no sparse allocation uses hostile offsets as array lengths.

- [ ] **Step 2: Run an independent review/fix loop**

Use the repository review process with two independent axes:

- **Standards:** AGENTS invariants, strict schemas, deep module boundaries, deterministic services, no fake production completeness, bounded security behaviour.
- **Spec:** every requirement in `docs/superpowers/specs/2026-07-19-representation-audit-design.md` and backlog T-11-02 acceptance criteria.

Pin reviewers to the exact base/head SHAs. Fix blocking/major findings test-first, rerun focused tests, then re-review until both axes PASS or report a genuine spec blocker.

- [ ] **Step 3: Run the full repository gate**

```bash
pnpm check
```

Expected: TypeScript, ESLint, all Vitest tests, integrity checks, web build, and Node build exit 0. Vitest remains limited by repository configuration/two-worker policy.

- [ ] **Step 4: Run bundle and formatting gates**

```bash
pnpm exec vitest run code/integration/ingest-bundle-validator.test.ts --maxWorkers=2
python docs/specs/automatic-ingestion-v3/source-bundle/tools/validate_bundle.py
pnpm exec prettier --check \
  code/domain/ingest/representation-audit.ts \
  code/domain/ingest/index.ts \
  code/domain/ingest/schema-registry.ts \
  code/domain/ingest/schema-registry.test.ts \
  code/ingest/source/representation-auditor.ts \
  code/ingest/source/representation-auditor.test.ts \
  code/ingest/source/index.ts \
  code/integration/representation-audit.integration.test.ts \
  docs/superpowers/specs/2026-07-19-representation-audit-design.md \
  docs/superpowers/plans/2026-07-19-representation-audit.md
git diff --check b42f0b8..HEAD
git status --short
```

Expected: bundle integration passes, preserved bundle reports `OK: validated 223 files`, formatting/diff checks pass, and the worktree contains no uncommitted files.

- [ ] **Step 5: Commit any final review-only corrections**

If review changed files after Task 4:

```bash
git add code/domain/ingest code/ingest/source \
  code/integration/representation-audit.integration.test.ts \
  docs/superpowers/specs/2026-07-19-representation-audit-design.md \
  docs/superpowers/plans/2026-07-19-representation-audit.md
git commit -m "fix(ingest): harden representation audits"
```

Do not create an empty commit.

- [ ] **Step 6: Report handoff evidence without merging**

Return to the coordinator:

- final branch and HEAD SHA;
- RED evidence for domain, policy, mapping, CSV, and integration slices;
- focused and full test counts;
- typecheck/lint/integrity/build, bundle, formatting, and diff-check results;
- independent Standards/Spec verdicts;
- any conservative policy limitations or unresolved concerns.

The coordinator—not the implementer—merges to `main`, runs post-merge verification, marks `P2.M1.E2.T002` done, updates the durable ledger, and safely removes the worktree after inspecting untracked/ignored files.

--- SUMMARY ---

- Add strict, canonical capability/finding/audit schemas with cross-field eligibility invariants and schema-registry migration tests.
- Register six immutable A-tier capabilities and expose one deterministic source auditor; malformed top-level representation returns typed `INVALID_INPUT`, while capability failures produce canonical ineligible audits.
- Independently validate line and CSV locator structure, order, coverage, coordinates, and safe bounds in linear passes; derive all outcomes and keep findings stable/bounded.
- Enforce policy decisively: passing Tier A only is eligible; Tier B lacks render qualification; Tier C awaits later named per-unit verification; Tier D/unknown never qualifies.
- Prove the public extraction-to-audit seam rejects post-extraction corruption, then run independent Standards/Spec review, full repository checks, both bundle validators, formatting, and diff gates before coordinator integration.
