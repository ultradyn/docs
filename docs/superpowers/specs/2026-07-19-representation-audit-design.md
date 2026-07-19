# T-11-02 Representation Audit Design

## Purpose

T-11-02 adds an independent deterministic qualification step between A-tier extraction and structural unitization. It classifies representation capability, checks that a `SourceRepresentation` is internally coherent, emits a durable-shaped audit record, and derives whether the representation may enter the later source-unit/claim pipeline.

The audit proves representation self-consistency. It does not re-prove fidelity to original bytes because its planned input is only `SourceRepresentation`; T-11-01 already binds extraction to a canonical verified `SourceFile`. A later contract may add an original-byte re-audit, but this slice must not overstate that guarantee.

## Binding scope decisions

- Implement the six existing A-tier kinds only: Markdown, text, code, JSON, YAML, and CSV.
- Use a declarative, versioned capability registry and one deterministic auditor.
- Do not put audit logic inside extractors; the audit must independently reject mutated extractor output.
- Do not build Tier B render adapters, Tier C source units/verification persistence, repairs, claims, or an audit repository.
- Tier C is fail-closed at representation level. Only a later named verification record scoped to a selected source unit may authorise that unit. There is no representation-wide human-verification escape hatch.
- Tier D and unknown capability are never claim-eligible.

## Domain contracts

Create `code/domain/ingest/representation-audit.ts` and export it through the domain barrel.

### Capability

A strict `RepresentationCapability` describes policy and required checks, never outcomes:

- `schemaVersion: 1`
- stable `id` and positive safe-integer `version`
- exact `representationKind`
- `tier: "A" | "B" | "C" | "D"`
- a closed, sorted set of required checks from the auditor-supported vocabulary

The initial built-in registry is readonly and contains one explicit A-tier capability for each of the six supported representation kinds. Unknown kinds, absent capabilities, malformed capabilities, kind mismatches, unsupported tiers, unsupported check names, and unsupported capability versions fail closed.

### Findings

`RepresentationAuditFinding` is a closed discriminated union with:

- stable finding code;
- severity (`error` or `warning` where warning cannot grant eligibility);
- deterministic message;
- optional locator index or cell coordinates when a specific entry is affected.

Required finding classes cover invalid representation/capability records, capability-kind mismatch, unsupported tier/check/version, missing or wrong locator shape, unsafe/out-of-bounds/inverted coordinates, unsorted/overlapping/duplicate locators, line/column mismatch, and CSV cell-order mismatch. Findings are deduplicated and sorted by stable code and location.

### Audit record

`RepresentationAudit` is a strict, schema-versioned immutable record containing:

- `schemaVersion: 1`;
- `representationId`;
- a discriminated capability reference: resolved ID/version, or `unresolved` when capability input cannot be validated;
- `tier`;
- `structuralPass`;
- `mappingPass`;
- `humanVerified: false` in this slice;
- derived `claimEligible`;
- sorted readonly findings.

Canonical Zod schemas for the capability, finding, and audit record are exported through the domain module. `RepresentationAuditSchema` is registered in the canonical ingest schema registry, replacing any placeholder rather than creating a parallel schema.

## Module boundary

Create `code/ingest/source/representation-auditor.ts` and export it through `code/ingest/source/index.ts`.

Its public surface is deliberately small:

- readonly lookup of the built-in capability for a `SourceRepresentationKind`;
- `auditRepresentation(representation, capability?)`.

The explicit capability argument supports deterministic tests and future adapters. It does not let a caller inject outcomes or arbitrary check code. All returned state is derived by the auditor. When capability input is malformed, the audit records an `unresolved` capability reference rather than inventing an ID or version.

The function returns `IngestResult<RepresentationAudit, "INVALID_INPUT">`. A runtime input that cannot supply a canonical representation identity returns typed `INVALID_INPUT`, because no schema-valid audit can truthfully reference a malformed ID. Once the representation itself is canonical, audit and capability failures return schema-valid fail-closed records rather than exceptions. The implementation does not persist records; repository custody is outside T-11-02.

## Audit algorithm

1. Strict-parse the `SourceRepresentation`. If invalid, return typed `INVALID_INPUT`; do not mint a misleading audit against an unvalidated identity.
2. Resolve and strict-parse the supplied or built-in capability. For a canonical representation, reject absent, malformed, mismatched, or unsupported capabilities into deterministic findings.
3. Run all declared supported checks in bounded linear passes.
4. Deduplicate and sort findings.
5. Derive check booleans from findings; callers cannot supply them.
6. Derive tier policy and eligibility.
7. Strict-parse the complete audit record before returning it. The audit schema enforces cross-field policy invariants: booleans must agree with error findings; `humanVerified` is false in v1; and `claimEligible` can be true only for a fully passing Tier A record.

### Structural checks

For non-empty representations, the locator collection cannot pass vacuously.

- Markdown, text, code, JSON, and YAML require line/span geometry consistent with their normalized text and prohibit CSV cell metadata.
- CSV requires cell locators with positive row/column coordinates, contiguous row-major cell order, and no duplicate cell identity.
- Empty content uses explicit per-kind rules rather than an accidental empty-loop pass.
- Locator entries must have the shape required by the capability and representation kind.

The auditor does not re-parse JSON, YAML, or CSV semantics already validated by T-11-01. It checks the immutable representation boundary and its structural mapping contract, avoiding a second parser that could disagree with extraction.

### Mapping checks

- All offsets, lines, columns, rows, and cell columns are safe integers in their documented bases.
- Normalized intervals are non-inverted and within `normalizedText.length`.
- Locator spans are deterministically ordered and non-overlapping; duplicates and reordered spans fail.
- Stored normalized line/column coordinates exactly equal recomputation from `normalizedText`, including LF-normalized output and JavaScript UTF-16 columns.
- Format-specific coverage rules detect dropped required lines/cells without requiring delimiters or newline terminators themselves to be locator-covered.
- Original coordinate fields receive shape/order/safety checks, but the auditor does not claim original-byte bounds without original bytes.

### Eligibility policy

| Tier            | Policy in T-11-02                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A               | Eligible only when every required structural/mapping check passes and no error finding exists.                         |
| B               | Ineligible because no render-audit capability exists in this slice.                                                    |
| C               | Representation-level ineligible even when self-consistency checks pass; later named per-unit verification is required. |
| D               | Permanently ineligible.                                                                                                |
| Unknown/invalid | Fail closed as ineligible.                                                                                             |

`humanVerified` is always false in T-11-02. A future per-unit verification record must not mutate or broaden this representation audit.

## Security and deterministic behaviour

- Strict schemas reject extra fields, unsafe integers, malformed IDs, and prototype-shaped input.
- The auditor performs bounded linear work over extractor-bounded normalized text and locator arrays; it does not recurse over user structure.
- Custom capability data can select only a closed set of built-in checks and cannot execute code.
- Capability tier alone never grants eligibility: required audit checks and the policy table are decisive.
- Repeated calls over equal input produce deeply equal records and identically ordered findings.
- Findings provide enough location context for repair without including raw source text or secrets.

## Human factors

Tier C findings explicitly say that a named human must verify each selected source unit later. The UI must not present a representation-wide “verified” state. Tier D findings say that the representation can be archived/excluded but cannot support accepted claims. Audit findings name the failed check and affected locator where possible, making corruption actionable rather than returning a generic false value.

## TDD and acceptance evidence

Tests use public barrels and start with failing behaviour tests before implementation.

### Unit and security

- A real T-11-01 golden representation audits deterministically and is A-tier eligible.
- Reordered, duplicated, overlapping, inverted, unsafe, and out-of-bounds locators fail.
- Forged normalized line/column values fail, including CR-derived and non-ASCII UTF-16 cases.
- Dropped required line/cell coverage fails.
- CSV duplicate/skipped/reordered row-column identities fail.
- A malformed top-level representation returns typed `INVALID_INPUT`; capability-kind mismatch, malformed/extra capability fields, unsupported version/check/tier, and absent capability fail closed as audit findings once representation identity is canonical.
- A caller cannot smuggle `claimEligible`, `humanVerified`, or check outcomes through capability input.
- Repeated audits and finding order are byte-stable.

### Tier and human-factor policy

- Tier A becomes eligible only after every required check passes.
- Tier B remains ineligible without a render adapter.
- Tier C remains representation-level ineligible and emits the per-selected-unit verification requirement.
- Tier D remains ineligible even if representation geometry is otherwise valid.

### Integration and migration

- A test imports extraction and audit from their public source barrel, extracts a committed golden fixture, audits it, then corrupts a copy and observes decisive failure.
- The canonical schema registry accepts current v1 audit records and rejects missing, legacy-version, extra-field, unsafe-integer, and inconsistent records.
- Full `pnpm check`, focused tests with at most two workers, the bundle integration validator, the preserved 223-file bundle validator, formatting, and `git diff --check` gate completion.

## Future seams

- Tier B adapters may add deterministic structure/render evidence behind the same capability vocabulary only when golden fixtures exist.
- Tier C named verification belongs to a later source-unit-scoped record and must reference the audit/representation version it authorises.
- T-11-03 repairs create a new representation version and a new audit; they never alter this audit or the faulty representation.
- T-12-01 consumes only a claim-eligible audit paired with the exact audited representation ID.
