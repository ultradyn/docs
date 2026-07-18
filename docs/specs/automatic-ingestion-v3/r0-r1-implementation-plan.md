# Automatic Ingestion v3 — R0/R1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the R0 laboratory and R1 evidence-core vertical slice for automatic ingestion: immutable source capture, deterministic structural retrieval, evidence and claim records, isolated agent evaluation, and claim-only answer composition over the tiny and small corpora.

**Architecture:** `code/ingest/` is one deep production module whose public surface is `code/ingest/index.ts`; deterministic services own identifiers, validation, filesystem writes, transitions, idempotency, and Git-authoritative logical records. Ingestion records are orthogonal to the canonical `QuestionRecord`: they reference questions but never introduce a competing question lifecycle. Machine indexes, run events, leases, and replay bytes remain local; portable accepted records remain diff-friendly Git files.

**Tech stack:** TypeScript/ESM, Node 22/24, pnpm, Vitest, Zod, MiniSearch, Fastify-era repository/provider conventions, deterministic fakes, Git-backed portable state.

## Global constraints

- Work in a claimed task worktree under `.worktrees/`; each numbered task is one reviewer-sized red→green slice and one commit.
- Use only agreed seams from `docs/engineering/tdd-seams.md`. Add the five ingestion seams in T-00-02 before testing them: source custody, source representation, ingestion knowledge repository, ingestion graph gateway, and ingestion fixture runner. Test public exports; never mock an internal module.
- Limit Vitest to two workers: `pnpm exec vitest run <path> --maxWorkers=2`. Run `VITEST_MAX_THREADS=2 pnpm check` after each milestone and before handoff.
- The preserved `docs/specs/automatic-ingestion-v3/source-bundle/` is inert, byte-preserved provenance. Production code and curated fixtures must not import, read, glob, copy, or dynamically load it.
- `QuestionRecord.state` in `question.md` is the only question lifecycle. `IngestionQuestionLink`, `CoverageObligation`, evidence, claims, graph events, and compositions are orthogonal records.
- Raw artifacts and replay capsules are append-only. T-10-03 deliberately implements seal/verify/export/retention and mutation/deletion rejection; no erase/purge implementation may begin until a new ADR reconciles authorised custody deletion with ADR-0001.
- IDs, hashes, writes, priority precedence, lifecycle transitions, and idempotency belong to deterministic services. Agents return schema-validated proposals only.
- Every evaluator invocation uses a fresh provider call. Evidence Critic cannot propose child questions. Claim Reviewer cannot reuse Claim Extractor context. Answer Composer receives a sealed claim pack and has no retrieval tools.
- `AnswerComposition` is distinct from transcript-derived `answers/structured.md`; compatibility is read-only and explicit.
- Later publication must reuse the existing change-request manager and its actual-diff Reviewer, diff-only Diff Summarizer, and post-diff Simulated Asker. R0/R1 creates no second publication/worktree subsystem.
- T-12-04, T-30-03, and T-31-03 are optional, non-gating experiments. No core task consumes their outputs.
- A deletion-capable API, vectors in production, SQLite, B/C/D-tier extraction, and direct source-bundle loading are outside R0/R1.

## Fixed public type vocabulary

These names are introduced by the tasks below and must not drift:

```ts
export type Sha256 = string & { readonly __sha256: unique symbol };
export type SnapshotId = string & { readonly __snapshotId: unique symbol };
export type SourceFileId = string & { readonly __sourceFileId: unique symbol };
export type SourceUnitId = string & { readonly __sourceUnitId: unique symbol };
export type QuestionId = string & { readonly __questionId: unique symbol };
export type ObligationId = string & { readonly __obligationId: unique symbol };
export type EvidencePacketId = string & { readonly __packetId: unique symbol };
export type ClaimId = string & { readonly __claimId: unique symbol };
export type GraphRevision = number & {
  readonly __graphRevision: unique symbol;
};
export type IngestResult<T, C extends string> =
  { ok: true; value: T } | { ok: false; code: C; message: string };
```

All task-level interfaces below are exported from the named module `index.ts` and re-exported only from `code/ingest/index.ts` or `code/domain/ingest/index.ts`.

---

## R0 / M0 — contracts and laboratory

### Task T-00-01: Approve and machine-check the v3 architecture baseline

**IDs:** Backlog `P1.M1.E1.T001`; bundle `T-00-01`

**Depends on:** none

**Files:**

- Create: `docs/architecture/automatic-ingestion-v3.md`
- Create: `code/integration/ingest-architecture.test.ts`
- Modify: `docs/architecture.md`
- Test: `code/integration/ingest-architecture.test.ts`

**Interfaces:**

- Consumes: ADR-0001 canonical lifecycle/raw immutability, ADR-0002 Git/local split, ADR-0005 ingestion adoption, ADR-0006 ledger precedence.
- Produces: normative headings `Authority boundaries`, `Agent isolation`, `Completion predicate`, and `Deferred activation`; architecture test helper `readArchitecture(): Promise<string>` local to the test.

- [ ] **Red:** add a test which reads the addendum and asserts it states: canonical `QuestionRecord.state`; orthogonal ingestion records; inert source bundle; deterministic writes; fresh Evidence Critic and Claim Reviewer calls; distinct `AnswerComposition`; existing change-request manager reuse. Run `pnpm exec vitest run code/integration/ingest-architecture.test.ts --maxWorkers=2`. **Expected failure:** `ENOENT ... docs/architecture/automatic-ingestion-v3.md`.
- [ ] **Green:** create the addendum and link it from `docs/architecture.md`; include this exact completion rule:

```md
A question is never complete because ingestion exhausted a search. Completion remains a canonical QuestionRecord transition and is blocked by any active P1 contradiction. Accepted claims and answer compositions are evidence products, not lifecycle authorities.
```

- [ ] **Pass:** run the same Vitest command; expect `1 passed` and no source-bundle access.
- [ ] **Commit:** `git commit -m "docs(ingest): define v3 architecture baseline"`.

### Task T-00-02: Define repository conventions and agreed ingestion seams

**IDs:** Backlog `P1.M1.E1.T002`; bundle `T-00-02`

**Depends on:** T-00-01

**Files:**

- Modify: `docs/architecture/automatic-ingestion-v3.md`
- Modify: `docs/engineering/tdd-seams.md`
- Modify: `code/integration/ingest-architecture.test.ts`
- Test: `code/integration/ingest-architecture.test.ts`

**Interfaces:**

- Consumes: existing `Knowledge repository`, `Raw artifact store`, `Provider contract`, `Agent runtime`, and `Change request` seams.
- Produces: agreed seams `Source custody`, `Source representation`, `Ingestion knowledge repository`, `Ingestion graph gateway`, `Ingestion fixture runner`; fixed roots `sources/snapshots/`, `ingest/claims/`, `.ultradyn/runtime/ingest/`.

- [ ] **Red:** extend the architecture test to require all five seam rows and explicit Git/local/append-only classifications. Run the targeted Vitest command. **Expected failure:** assertion reports missing `Source custody`.
- [ ] **Green:** add the five rows to `docs/engineering/tdd-seams.md`; document that canonical logical records are one-file-per-record, replay bytes/events/indexes are local, IDs are content-derived or injected deterministic `IdGenerator.next(kind): string`, and queue folders remain projections.
- [ ] **Pass:** run the targeted Vitest command; expect all assertions to pass.
- [ ] **Commit:** `git commit -m "docs(ingest): agree repository seams and paths"`.

### Task T-00-03: Define decision-change and agent-contract review rules

**IDs:** Backlog `P1.M1.E1.T003`; bundle `T-00-03`

**Depends on:** T-00-02

**Files:**

- Create: `docs/engineering/ingestion-change-control.md`
- Modify: `code/integration/ingest-architecture.test.ts`
- Test: `code/integration/ingest-architecture.test.ts`

**Interfaces:**

- Consumes: repository change-request seam and deterministic agent fixtures.
- Produces: `IngestionChangeClass = "schema" | "workflow" | "agent" | "policy" | "architecture"`; review matrix requiring migration impact, paired valid/invalid fixtures, and fresh-context verification.

- [ ] **Red:** test that every `IngestionChangeClass` appears with required fixture, migration, and reviewer fields, and that architecture/policy changes name an ADR gate. Run the targeted Vitest command. **Expected failure:** `ENOENT ... ingestion-change-control.md`.
- [ ] **Green:** author the review matrix and state that the existing change-request manager creates the actual diff and evaluation lane; no ingestion-specific branch manager is permitted.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "docs(ingest): define decision change control"`.

### Task T-01-01: Implement the curated ingestion schema registry

**IDs:** Backlog `P1.M1.E2.T001`; bundle `T-01-01`

**Depends on:** T-00-03

**Files:**

- Create: `code/domain/ingest/types.ts`
- Create: `code/domain/ingest/schemas.ts`
- Create: `code/domain/ingest/schema-registry.ts`
- Create: `code/domain/ingest/index.ts`
- Create: `code/domain/ingest/schema-registry.test.ts`
- Modify: `code/domain/schemas.ts`
- Test: `code/domain/ingest/schema-registry.test.ts`

**Interfaces:**

- Consumes: Zod and the existing portable schema-validation surface in `code/domain/schemas.ts`.
- Produces: `IngestSchemaName`, `IngestSchemaRegistry.get(name, version): z.ZodType`, `validateIngestRecord<T>(name, version, input): IngestResult<T, "UNKNOWN_SCHEMA" | "INVALID_RECORD">`, `registerIngestSchemas(): void`, plus branded IDs from the fixed vocabulary.

- [ ] **Red:** test valid minimal records, a 63-character digest, an extra property, unknown version `2`, and error path `files.0.sha256`. Run `pnpm exec vitest run code/domain/ingest/schema-registry.test.ts --maxWorkers=2`. **Expected failure:** module resolution fails for `./schema-registry.js`.
- [ ] **Green:** implement a closed registry and exact-object Zod schemas:

```ts
export type IngestSchemaName =
  | "PolicyProfile"
  | "SourceSnapshot"
  | "SourceFile"
  | "SourceUnit"
  | "SearchReceipt"
  | "IngestionQuestionLink"
  | "CoverageObligation"
  | "EvidencePacket"
  | "EvidenceVerdict"
  | "Claim"
  | "ClaimReview"
  | "GraphEvent"
  | "SealedClaimPack"
  | "AnswerComposition";
export interface IngestSchemaRegistry {
  get(name: IngestSchemaName, version: 1): z.ZodType;
}
```

Register only curated repo-native schemas; do not enumerate or parse the preserved bundle.

- [ ] **Pass:** targeted Vitest passes; then `VITEST_MAX_THREADS=2 pnpm check` passes.
- [ ] **Commit:** `git commit -m "feat(ingest): add curated schema registry"`.

### Task T-01-02: Validate agent and workflow manifests

**IDs:** Backlog `P1.M1.E2.T002`; bundle `T-01-02`

**Depends on:** T-01-01

**Files:**

- Create: `code/agents/ingest-manifest.ts`
- Create: `code/agents/ingest-manifest.test.ts`
- Create: `scaffold/agents/ingest-workflow.schema.json`
- Modify: `code/agents/index.ts`
- Test: `code/agents/ingest-manifest.test.ts`

**Interfaces:**

- Consumes: `IngestSchemaRegistry`, existing agent definition loader and input-policy vocabulary.
- Produces:

```ts
export type IngestAgentRole =
  | "researcher"
  | "evidence-critic"
  | "claim-extractor"
  | "claim-reviewer"
  | "answer-composer";
export interface IngestAgentManifest {
  role: IngestAgentRole;
  outputSchema: string;
  tools: readonly string[];
  freshContext: boolean;
  next: readonly string[];
}
export function validateIngestManifests(
  input: readonly IngestAgentManifest[],
): IngestResult<
  true,
  | "DANGLING_REFERENCE"
  | "EVALUATOR_NOT_FRESH"
  | "UNREACHABLE_STATE"
  | "TOOL_DENIED"
>;
```

- [ ] **Red:** test a dangling schema, `evidence-critic` with `freshContext:false`, Answer Composer with `source.search`, and a nonterminal state with no successor. Run targeted Vitest. **Expected failure:** `validateIngestManifests is not exported`.
- [ ] **Green:** validate exact role allowlists; require fresh context for Evidence Critic and Claim Reviewer, and zero retrieval tools for Answer Composer.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(agents): validate ingestion manifests"`.

### Task T-01-03: Implement the TypeScript bundle/link validator

**IDs:** Backlog `P1.M1.E2.T003`; bundle `T-01-03`

**Depends on:** T-01-02

**Files:**

- Create: `code/integration/ingest-bundle-validator.ts`
- Create: `code/integration/ingest-bundle-validator.test.ts`
- Create: `code/integration/fixtures/ingest-bundle/{valid,broken-link,cycle,committed-index}/`
- Modify: `code/integration/index.ts`
- Test: `code/integration/ingest-bundle-validator.test.ts`

**Interfaces:**

- Consumes: `validateIngestManifests`, portable schemas, injected `FileReader` system boundary.
- Produces: `validateIngestBundle(root: string, io: FileReader): Promise<BundleValidationReport>` where `BundleValidationReport = { ok:boolean; schemaErrors:string[]; brokenLinks:string[]; cycles:string[][]; forbiddenArtifacts:string[] }`.

- [ ] **Red:** assert a known valid curated fixture yields an exact report and the three invalid fixtures identify `missing.md`, `T-A -> T-B -> T-A`, and `.minisearch`. Run targeted Vitest. **Expected failure:** module resolution fails for `ingest-bundle-validator.js`.
- [ ] **Green:** walk only the provided curated fixture root, sort paths/edges before reporting, reject binary/machine index suffixes, and never special-case the preserved source-bundle path.
- [ ] **Pass:** targeted Vitest passes and two consecutive report serialisations are byte-identical.
- [ ] **Commit:** `git commit -m "feat(ingest): validate curated bundles and links"`.

### Task T-01-04: Define the minimal ingestion policy-profile contract (synthetic prerequisite)

**IDs:** Backlog `P1.M1.E2.T004`; synthetic policy-contract task `T-01-04` (no bundle leaf)

**Depends on:** T-01-01

**Files:**

- Create: `code/domain/ingest/policy-profile.ts`
- Create: `code/domain/ingest/policy-profile.test.ts`
- Create: `scaffold/schemas/ingest/policy-profile.schema.json`
- Modify: `code/domain/ingest/schemas.ts`
- Modify: `code/domain/ingest/index.ts`
- Test: `code/domain/ingest/policy-profile.test.ts`

**Interfaces:**

- Consumes: schema registry.
- Produces:

```ts
export type DataClass = "public" | "internal" | "confidential" | "prohibited";
export interface PolicyProfile {
  schemaVersion: 1;
  id: string;
  approved: boolean;
  dataClass: DataClass;
  include: readonly string[];
  exclude: readonly string[];
  allowedMediaTypes: readonly string[];
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
}
export const PolicyProfileSchema: z.ZodType<PolicyProfile>;
```

- [ ] **Red:** parse one approved fixture and reject `approved:false`, `prohibited`, negative limits, overlapping include/exclude literals, and unknown keys. Run targeted Vitest. **Expected failure:** `PolicyProfileSchema` import fails.
- [ ] **Green:** implement strict validation and a refinement that reports `include/exclude overlap`; this contract authorises preflight only, not provider/storage/publication exposure.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): define preflight policy profile"`.

### Task T-02-01: Build the tiny and small labelled corpora

**IDs:** Backlog `P1.M1.E3.T001`; bundle `T-02-01`

**Depends on:** T-01-03

**Files:**

- Create: `code/integration/fixtures/ingest-corpus/tiny/source/`
- Create: `code/integration/fixtures/ingest-corpus/tiny/expected-graph.json`
- Create: `code/integration/fixtures/ingest-corpus/small/source/`
- Create: `code/integration/fixtures/ingest-corpus/small/expected-graph.json`
- Create: `code/integration/ingest-corpus.test.ts`
- Test: `code/integration/ingest-corpus.test.ts`

**Interfaces:**

- Consumes: curated examples and this repository’s documentation; no runtime source-bundle path.
- Produces: `ExpectedCorpusGraph = { files; units; questions; claims; duplicates; contradictions; unsupportedQuestions }` with stable literal IDs/digests.

- [ ] **Red:** test that tiny includes overview, procedure, deprecation, contradiction, disconnected note, duplicate, unsupported question, and a disposition for every expected unit; require small to contain at least 20 files and two reusable claims. Run targeted Vitest. **Expected failure:** fixture path does not exist.
- [ ] **Green:** author both corpora and hand-labelled graphs; record provenance in fixture README files without importing preserved files at runtime.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "test(ingest): add labelled tiny and small corpora"`.

### Task T-02-02: Define executable quality metrics and labelling rules

**IDs:** Backlog `P1.M1.E3.T002`; bundle `T-02-02`

**Depends on:** T-02-01

**Files:**

- Create: `code/integration/ingest-metrics.ts`
- Create: `code/integration/ingest-metrics.test.ts`
- Create: `docs/engineering/ingestion-labelling-guide.md`
- Modify: `code/integration/index.ts`
- Test: `code/integration/ingest-metrics.test.ts`

**Interfaces:**

- Consumes: `ExpectedCorpusGraph` and observed fixture outcomes.
- Produces: `IngestMetrics = { evidenceRecall:number; evidencePrecision:number; falseNoEvidenceRate:number; claimEntailmentRate:number; falseMergeRate:number; contradictionRecall:number; sourceCoverage:number; answerSufficiency:number }`; `scoreIngestRun(expected, observed): IngestMetrics`.

- [ ] **Red:** use a worked literal confusion matrix and assert exact fractions; assert answer sufficiency and source coverage differ. Run targeted Vitest. **Expected failure:** `scoreIngestRun` is missing.
- [ ] **Green:** implement denominator-safe metric functions and document adjudication plus inter-rater disagreement resolution.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "test(ingest): define quality metrics and labels"`.

### Task T-02-03: Build the versioned fixture runner and result store

**IDs:** Backlog `P1.M1.E3.T003`; bundle `T-02-03`

**Depends on:** T-02-02

**Files:**

- Create: `code/integration/ingest-fixture-runner.ts`
- Create: `code/integration/ingest-fixture-runner.test.ts`
- Create: `code/integration/fixtures/ingest-results/baseline.json`
- Modify: `code/integration/index.ts`
- Test: `code/integration/ingest-fixture-runner.test.ts`

**Interfaces:**

- Consumes: `scoreIngestRun`, injected public seam adapters, deterministic fake providers.
- Produces:

```ts
export interface IngestFixtureVersions {
  model: string;
  prompt: string;
  tools: string;
  index: string;
  schemas: string;
}
export interface IngestFixtureResult {
  corpus: "tiny" | "small";
  versions: IngestFixtureVersions;
  cacheEnabled: false;
  metrics: IngestMetrics;
  decisiveDiffs: string[];
}
export function runIngestFixture(
  input: IngestFixtureInput,
): Promise<IngestFixtureResult>;
```

- [ ] **Red:** assert cache is disabled, versions are required, stable runs serialise identically, and changing one verdict reports its JSON pointer. Run targeted Vitest. **Expected failure:** runner module is missing.
- [ ] **Green:** implement dependency injection at public seams, stable key ordering, and literal decisive-field comparison; absent M1 services return `not_implemented` results rather than passing.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "test(ingest): add deterministic fixture runner"`.

---

## R1 / M1 — deterministic source plane

### Task T-10-01: Implement package preflight

**IDs:** Backlog `P2.M1.E1.T001`; bundle `T-10-01`

**Depends on:** T-01-04, T-02-03

**Files:**

- Create: `code/ingest/source/preflight.ts`
- Create: `code/ingest/source/preflight.test.ts`
- Create: `code/ingest/source/fixtures/{valid,traversal,symlink,bomb,prohibited}/`
- Create: `code/ingest/source/index.ts`
- Modify: `code/ingest/index.ts`
- Test: `code/ingest/source/preflight.test.ts`

**Interfaces:**

- Consumes: `PolicyProfile`, injected `ArchiveReader` returning metadata without extraction.
- Produces: `preflightPackage(input:{ archivePath:string; policy:PolicyProfile; archive:ArchiveReader }): Promise<IngestResult<PreflightManifest,"PATH_TRAVERSAL"|"LINK_ESCAPE"|"LIMIT_EXCEEDED"|"MEDIA_DENIED"|"POLICY_DENIED">>`; manifest entries include `{logicalPath,mediaType,size,included,reason}`.

- [ ] **Red:** assert traversal, symlink, expanded-byte bomb, and prohibited content fail before `ArchiveReader.extract` is called; assert every included/excluded path is listed. Run targeted Vitest. **Expected failure:** preflight module missing.
- [ ] **Green:** normalise POSIX paths, reject absolute/`..`/links, calculate counts and sizes from headers, classify every entry, and return a manifest only; do not extract bytes.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): preflight source packages"`.

### Task T-10-02: Create immutable source snapshots

**IDs:** Backlog `P2.M1.E1.T002`; bundle `T-10-02`

**Depends on:** T-10-01

**Files:**

- Create: `code/domain/ingest/source-records.ts`
- Create: `code/ingest/source/snapshot-service.ts`
- Create: `code/ingest/source/snapshot-service.test.ts`
- Modify: `code/domain/ingest/index.ts`
- Modify: `code/ingest/source/index.ts`
- Test: `code/ingest/source/snapshot-service.test.ts`

**Interfaces:**

- Consumes: successful `PreflightManifest`, injected append-only `RawArtifactStore`, `HashService`, and `IdGenerator`.
- Produces: `SourceFile`, `SourceSnapshot`, and `SourceSnapshotService.create(input): Promise<IngestResult<SourceSnapshot,"DIGEST_MISMATCH"|"PARTIAL_WRITE"|"SNAPSHOT_CONFLICT">>`; `SourceSnapshotService.verify(id): Promise<ReplayReceipt>`.

```ts
export interface SourceSnapshot {
  schemaVersion: 1;
  id: SnapshotId;
  packageSha256: Sha256;
  policyId: string;
  files: readonly SourceFile[];
  qualified: true;
}
export interface SourceFile {
  id: SourceFileId;
  snapshotId: SnapshotId;
  logicalPath: string;
  mediaType: string;
  size: number;
  sha256: Sha256;
}
```

- [ ] **Red:** assert same package+policy returns the same snapshot, every digest is verified, and an injected third-file write failure leaves no qualified manifest. Run targeted Vitest. **Expected failure:** `SourceSnapshotService` missing.
- [ ] **Green:** stage bytes under a transaction directory, hash while writing, fsync, atomically publish the manifest last, and derive idempotency from package digest plus policy id.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): create immutable source snapshots"`.

### Task T-10-03: Seal and verify replay capsules without deletion

**IDs:** Backlog `P2.M1.E1.T003`; bundle `T-10-03` (custody/replay portion only)

**Depends on:** T-10-02

**Files:**

- Create: `code/ingest/source/replay-capsule.ts`
- Create: `code/ingest/source/replay-capsule.test.ts`
- Modify: `code/ingest/source/index.ts`
- Test: `code/ingest/source/replay-capsule.test.ts`

**Interfaces:**

- Consumes: `SourceSnapshot`, append-only raw store.
- Produces: `ReplayCapsuleStore.seal(snapshot): Promise<ReplayReceipt>`, `.verify(snapshotId): Promise<ReplayReceipt>`, `.export(snapshotId, destination): Promise<ReplayReceipt>`, `.retention(snapshotId): Promise<RetentionState>`; no deletion method.

- [ ] **Red:** assert promotion rejects an unverified capsule, retained bytes replay after the upload fixture is removed, attempted overwrite/unlink returns `IMMUTABLE_RAW_ARTIFACT`, and the public type has no `delete`, `erase`, or `purge` member. Run targeted Vitest. **Expected failure:** replay-capsule module missing.
- [ ] **Green:** seal a content-addressed capsule, verify all file hashes, export by copy+rehash, and expose retention metadata. Add a code comment naming the required future deletion ADR; do not add deletion-capable code or receipt types.
- [ ] **Pass:** targeted Vitest passes. The bundle’s deletion-drill criterion remains explicitly deferred to the post-ADR release ledger and does not weaken R1 source recovery.
- [ ] **Commit:** `git commit -m "feat(ingest): seal immutable replay capsules"`.

### Task T-10-04: Define and implement authorised replay-capsule deletion (blocked; do not execute)

**IDs:** Backlog `P2.M1.E1.T004`; synthetic C12 split from bundle `T-10-03` deletion/purge criteria

**Depends on:** T-10-03 and acceptance of the C12 source-custody deletion ADR (drafted as ADR 0007, status proposed). This task is blocked and no downstream task may depend on it.

**DO NOT EXECUTE this task** until ALL of the following hold. ADR acceptance alone is explicitly insufficient, because this task includes destructive implementation and a deletion drill:

1. **ADR 0007 accepted** — records the architecture; confers no authority to erase.
2. **D9 ratified by Max** — retention schedules, legal bases, retention classes, and legal-hold recording/release.
3. **Every capability producer and adapter present** — graph/validity gateway, invalidation path, provider adapters, and a certificate signer whose adapter implements verification, rotation, and revocation. Any missing or unknown-status producer means no erasure (fail-closed).

**Required protocol and test gates when it does run.** The implementation must follow ADR 0007's PREPARE / EXECUTE / FINALISE protocol, in which the irreversible boundary is the **first confirmed destructive side effect** — not the `execution-authorised` marker, which authorises attempts and is still cancellable if recovery can prove nothing was destroyed. Deterministic fakes must cover at minimum: crash between journal write and freeze; crash after the marker but before any confirmed destruction (cancellable only once proven, provider reconciliation included); crash between request-recorded and outcome-recorded for a provider call; retry that must reconcile rather than assume success; unknown provider outcome treated as potentially irreversible, keeping the freeze and forbidding both a no-side-effect and a completeness claim; partial completion leaving content frozen and invalid with a partial certificate; unreachable replica producing a residual; and expected-inventory items never visited still appearing in the certificate. Erasure must remain a separate human-authorised capability — `RawArtifactStore` and `ReplayCapsuleStore` must not gain a delete member.

If non-destructive framework work is wanted before those gates clear, create a separately scoped task; do not silently rescope this one.

**Files (only once ALL THREE gates above are satisfied):** to be fixed when the task is unblocked. Do not create files, tests, or a branch before then.

**Interfaces (contract nouns, not a frozen TypeScript shape).** Erasure is a **separate `AuthorisedCustodyDeletion` capability**, never a method on `RawArtifactStore` or `ReplayCapsuleStore`.

- **Inputs:** a versioned deletion request; actor and authority reference; legal-hold decision; expected custody and policy revisions; immutable dependency-closure digest; the complete expected custody inventory (objects, replicas, providers, keys, Git locations); and operation plus idempotency identifiers.
- **Outputs:** a versioned certificate projection that is explicitly *partial* or *complete*, plus a protected-evidence digest.
- **Errors:** unsatisfied capability gate; legal hold; stale expected revision; incomplete inventory; provider outcome unknown; signer unavailable; reconciliation required.

Do not freeze the exact final TypeScript shape ahead of the gates; these nouns are the contract.

- [ ] **Red (only once all three gates are satisfied):** fail-closed coverage for each missing gate independently; PREPARE creates a durable journal and freeze while performing **zero** erasure; stale revision, active hold, and incomplete inventory each reject; crash and retry matrices across the journal transitions; `RawArtifactStore` and `ReplayCapsuleStore` still expose no delete member; a partial outcome cannot claim completeness; and an unreachable distributed copy produces a residual that forbids a completeness claim.
- [ ] **Green (only once all three gates are satisfied):** implement ADR 0007's PREPARE / EXECUTE / FINALISE journal protocol. There is no direct closure-then-delete thin flow.
- [ ] **Pass (only once all three gates are satisfied):** targeted suite plus full `pnpm check`.
- [ ] **Commit (only once all three gates are satisfied):** wording to be settled when the task is unblocked. Until then, make no implementation commit.

### Task T-11-01: Implement A-tier text extractors

**IDs:** Backlog `P2.M1.E2.T001`; bundle `T-11-01`

**Depends on:** T-10-03

**Files:**

- Create: `code/domain/ingest/representation-records.ts`
- Create: `code/ingest/source/extractors.ts`
- Create: `code/ingest/source/extractors.test.ts`
- Create: `code/ingest/source/fixtures/extraction/`
- Modify: `code/ingest/source/index.ts`
- Test: `code/ingest/source/extractors.test.ts`

**Interfaces:**

- Consumes: verified `SourceFile` bytes.
- Produces: `SourceRepresentation = { id; sourceFileId; version; kind:"markdown"|"text"|"code"|"json"|"yaml"|"csv"; normalizedText; locatorMap:readonly LocatorSpan[]; warnings:readonly ExtractionWarning[] }`; `extractATier(input): IngestResult<SourceRepresentation,"UNSUPPORTED_MEDIA"|"MALFORMED_ENCODING"|"MALFORMED_STRUCTURE">`.

- [ ] **Red:** golden-test Markdown, text, code, JSON/YAML, and CSV; run twice and compare bytes; verify every output line/cell maps to original byte/line coordinates; malformed UTF-8 reports exact offset. Run targeted Vitest. **Expected failure:** extractor export missing.
- [ ] **Green:** use deterministic parsers/serialisers, preserve original bytes separately, produce explicit locator spans, and sort warnings.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): extract deterministic A-tier representations"`.

### Task T-11-02: Audit representations and format capability

**IDs:** Backlog `P2.M1.E2.T002`; bundle `T-11-02`

**Depends on:** T-11-01

**Files:**

- Create: `code/domain/ingest/representation-audit.ts`
- Create: `code/ingest/source/representation-auditor.ts`
- Create: `code/ingest/source/representation-auditor.test.ts`
- Modify: `code/ingest/source/index.ts`
- Test: `code/ingest/source/representation-auditor.test.ts`

**Interfaces:**

- Consumes: `SourceRepresentation`.
- Produces: `FormatTier = "A"|"B"|"C"|"D"`; `RepresentationAudit = { representationId; tier; structuralPass; mappingPass; humanVerified; claimEligible; findings }`; `auditRepresentation(rep, capability): RepresentationAudit`.

- [ ] **Red:** corrupted/reordered mapping fails; Tier C lacks claim eligibility until human verification; Tier D never gains claim eligibility. Run targeted Vitest. **Expected failure:** auditor module missing.
- [ ] **Green:** add an A-tier capability registry only, deterministic structural/map checks, and fail-closed defaults for unknown tiers.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): audit source representations"`.

### Task T-12-01: Implement structural source-unit parsing

**IDs:** Backlog `P2.M1.E3.T001`; bundle `T-12-01`

**Depends on:** T-11-02 (audit, not repair)

**Files:**

- Create: `code/domain/ingest/source-unit.ts`
- Create: `code/ingest/source/unitizer.ts`
- Create: `code/ingest/source/unitizer.test.ts`
- Modify: `code/ingest/source/index.ts`
- Test: `code/ingest/source/unitizer.test.ts`

**Interfaces:**

- Consumes: claim-eligible `RepresentationAudit` and representation.
- Produces: `SourceUnit = { id; snapshotId; sourceFileId; representationId; kind:"document"|"section"|"paragraph"|"list"|"table"|"code"; parentId?; headingPath; normalizedLocator; originalLocator; textSha256 }`; `unitizeRepresentation(input): IngestResult<readonly SourceUnit[],"AUDIT_REQUIRED"|"TEXT_DROPPED">`.

- [ ] **Red:** assert literal unit tree/locators for headings, paragraph, list, table, code; unrelated edit preserves unaffected IDs; concatenated selected text equals expected source text. Run targeted Vitest. **Expected failure:** unitizer missing.
- [ ] **Green:** derive unit IDs from snapshot/file/structural path/text digest, preserve parent/heading relations, and fail if covered spans leave selected text unaccounted for.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): parse structural source units"`.

### Task T-11-03: Create immutable representation repair versions

**IDs:** Backlog `P2.M1.E2.T003`; bundle `T-11-03`

**Depends on:** T-11-02; may run in parallel with T-12-01

**Files:**

- Create: `code/ingest/source/representation-repair.ts`
- Create: `code/ingest/source/representation-repair.test.ts`
- Modify: `code/ingest/source/index.ts`
- Test: `code/ingest/source/representation-repair.test.ts`

**Interfaces:**

- Consumes: failed `RepresentationAudit`, `SourceRepresentation`, append-only store, unitizer invalidation port.
- Produces: `RepresentationRepairService.propose(input): Promise<RepresentationRepair>` and `.approve(id, reviewer): Promise<SourceRepresentation>`; new representation has `supersedesId` and monotonically increasing version.

- [ ] **Red:** assert approval creates version 2, original/faulty bytes remain readable, and dependent unit IDs are returned in `InvalidationRequest`; overwrite is rejected. Run targeted Vitest. **Expected failure:** repair module missing.
- [ ] **Green:** store correction as a new raw artifact plus derived representation, link supersession, and emit invalidation without mutating existing records.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): version representation repairs immutably"`.

### Task T-12-02: Build exact maps and ambiguity-aware aliases

**IDs:** Backlog `P2.M1.E3.T002`; bundle `T-12-02`

**Depends on:** T-12-01

**Files:**

- Create: `code/ingest/retrieval/exact-map.ts`
- Create: `code/ingest/retrieval/exact-map.test.ts`
- Create: `code/ingest/retrieval/index.ts`
- Modify: `code/ingest/index.ts`
- Test: `code/ingest/retrieval/exact-map.test.ts`

**Interfaces:**

- Consumes: `readonly SourceUnit[]`.
- Produces: `ExactMap.build(units): ExactMapProjection`; `ExactMap.lookup(alias): { kind:"unique"; unit:SourceUnitId } | { kind:"ambiguous"; candidates:readonly {unit:SourceUnitId;reason:string}[] } | { kind:"missing" }` for IDs, paths, titles, headings, acronyms, and error codes.

- [ ] **Red:** assert unique and ambiguous literal aliases, sorted candidates with reasons, and byte-identical rebuild after deleting the projection. Run targeted Vitest. **Expected failure:** exact-map module missing.
- [ ] **Green:** build normalised aliases from canonical units, retain all collisions, sort keys/candidates, and keep the projection disposable.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): build exact source maps"`.

### Task T-12-03: Build MiniSearch lexical retrieval and receipts

**IDs:** Backlog `P2.M1.E3.T003`; bundle `T-12-03`

**Depends on:** T-12-02

**Files:**

- Create: `code/domain/ingest/search-receipt.ts`
- Create: `code/ingest/retrieval/lexical-index.ts`
- Create: `code/ingest/retrieval/lexical-index.test.ts`
- Modify: `code/ingest/retrieval/index.ts`
- Test: `code/ingest/retrieval/lexical-index.test.ts`

**Interfaces:**

- Consumes: `SourceUnit`, `ExactMapProjection`, MiniSearch.
- Produces: `LexicalRetrieval.build(snapshotId, units): Promise<void>` and `.search(request:SearchRequest): Promise<IngestResult<SearchResponse,"INDEX_UNAVAILABLE">>`; response always contains `SearchReceipt { snapshotId,indexVersion,query,filters,candidateIds,selectedIds,failures }`.

- [ ] **Red:** tiny/small expected queries return labelled units; missing index returns `INDEX_UNAVAILABLE`; an empty healthy result returns `ok:true` with an empty selected list and receipt; deleted index rebuilds identically. Run targeted Vitest. **Expected failure:** lexical-index module missing.
- [ ] **Green:** index structural fields in MiniSearch, apply snapshot/scope/status filters before selection, stable-sort tied scores, persist no knowledge in the index, and emit engine-neutral receipts.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): add lexical retrieval receipts"`.

### Task T-12-04: Benchmark semantic retrieval without activating it (optional, non-gating)

**IDs:** Backlog `P2.M1.E3.T004`; bundle `T-12-04`

**Depends on:** T-12-03; **no downstream task may depend on this task**

**Files:**

- Create: `code/integration/ingest-semantic-benchmark.ts`
- Create: `code/integration/ingest-semantic-benchmark.test.ts`
- Create: `docs/engineering/automatic-ingestion-semantic-benchmark.md`
- Test: `code/integration/ingest-semantic-benchmark.test.ts`

**Interfaces:**

- Consumes: lexical fixture results and externally supplied candidate result JSON; no production vector adapter.
- Produces: `compareRetrievalRuns(lexical, candidate): { recallDelta; precisionDelta; p95LatencyDeltaMs; costDeltaAud; activation:"disabled" }`.

- [ ] **Red:** feed worked results and require exact quality/latency/cost deltas plus `activation:"disabled"`; assert production `code/ingest/` has no vector export. Run targeted Vitest. **Expected failure:** benchmark module missing.
- [ ] **Green:** implement an offline comparison/report writer only; state activation requires measured material gain and a future ADR, with no source migration.
- [ ] **Pass:** targeted Vitest passes. Failure or omission does not block M1/M2/M3.
- [ ] **Commit:** `git commit -m "chore(ingest): benchmark semantic retrieval offline"`.

### Task T-13-01: Expand approved data and rights policy profiles

**IDs:** Backlog `P2.M1.E4.T001`; bundle `T-13-01`

**Depends on:** T-10-03, T-11-03

**Files:**

- Modify: `code/domain/ingest/policy-profile.ts`
- Create: `code/ingest/policy/policy-service.ts`
- Create: `code/ingest/policy/policy-service.test.ts`
- Create: `code/ingest/policy/index.ts`
- Modify: `code/ingest/index.ts`
- Test: `code/ingest/policy/policy-service.test.ts`

**Interfaces:**

- Consumes: minimal `PolicyProfile`.
- Produces: fields `allowedProviders`, `allowedRegions`, `retention`, `logging`, `cache`, `maxQuoteBytes`, `publication`; `PolicyService.approve(profile, actor): ApprovedPolicyProfile`; `.assertRunAllowed(id): IngestResult<ApprovedPolicyProfile,"POLICY_UNAPPROVED">`.

- [ ] **Red:** reject run without approval, profile without explicit processors/storage, and restricted licence lacking publication rule. Run targeted Vitest. **Expected failure:** policy service missing.
- [ ] **Green:** validate all exposure/storage choices, write approval as a new portable record, and leave secrets/credentials outside the profile.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): enforce approved rights profiles"`.

### Task T-13-02: Enforce policy before retrieval and model exposure

**IDs:** Backlog `P2.M1.E4.T002`; bundle `T-13-02`

**Depends on:** T-13-01, T-12-03

**Files:**

- Create: `code/ingest/policy/policy-gate.ts`
- Create: `code/ingest/policy/policy-gate.test.ts`
- Modify: `code/ingest/policy/index.ts`
- Modify: `code/ingest/retrieval/index.ts`
- Test: `code/ingest/policy/policy-gate.test.ts`

**Interfaces:**

- Consumes: `ApprovedPolicyProfile`, `SearchResponse`, provider capability request.
- Produces: `PolicyGate.filterRetrieval(response, principal): FilteredSearchResponse`; `.authoriseModel(input:{profile,provider,region,unitIds}): IngestResult<ModelExposure,"ACCESS_DENIED"|"PROVIDER_DENIED"|"REGION_DENIED">`; `policyNamespace(profileId, principalId): string`.

- [ ] **Red:** restricted unit never reaches returned context/provider fake, preview respects labels, and two policy profiles produce distinct cache namespaces. Run targeted Vitest. **Expected failure:** policy-gate module missing.
- [ ] **Green:** filter IDs before opening text, authorise provider/region before a call, and derive cache namespace from profile+principal+snapshot.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): gate retrieval and model exposure"`.

### Task T-13-03: Scan intake and proposed changes for secrets/PII

**IDs:** Backlog `P2.M1.E4.T003`; bundle `T-13-03`

**Depends on:** T-13-02

**Files:**

- Create: `code/ingest/policy/content-scanner.ts`
- Create: `code/ingest/policy/content-scanner.test.ts`
- Modify: `code/ingest/policy/index.ts`
- Test: `code/ingest/policy/content-scanner.test.ts`

**Interfaces:**

- Consumes: source representations, actual diff text from existing change-request manager, injected `ContentScannerAdapter` fake.
- Produces: `scanContent(input): Promise<ScanResult>` where findings have action `"block"|"redact"|"quarantine"`; `applyAuthorisedRedaction(rep, findings): SourceRepresentation` preserving locator mapping.

- [ ] **Red:** seeded secret blocks before provider fake event, authorised PII redaction retains source spans, and prohibited actual diff fails. Run targeted Vitest. **Expected failure:** scanner module missing.
- [ ] **Green:** add deterministic fake scanner cases, execute scans at pre-model and pre-change-request boundaries, and create redacted derived representations rather than editing raw bytes.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): scan source and proposed diffs"`.

---

## R1 / M2 — knowledge core

### Task T-20-01: Link ingestion provenance to canonical questions

**IDs:** Backlog `P2.M2.E1.T001`; bundle `T-20-01`

**Depends on:** T-01-03, T-12-03 (not T-12-04)

**Files:**

- Create: `code/domain/ingest/question-link.ts`
- Create: `code/ingest/knowledge/question-link-service.ts`
- Create: `code/ingest/knowledge/question-link-service.test.ts`
- Create: `code/ingest/knowledge/index.ts`
- Modify: `code/ingest/index.ts`
- Test: `code/ingest/knowledge/question-link-service.test.ts`

**Interfaces:**

- Consumes: existing `QuestionRepository` public commands and `QuestionRecord` with canonical `state`, `askers`, `tier`, `revision`, raw/generated origin.
- Produces: `IngestionQuestionLink { questionId; snapshotId; origin:"human"|"ingestion-generated"|"reverse"; systemActor?; rawArtifactId; generation; sourceUnitIds; createdRevision }`; `QuestionLinkService.link(input)` and `.read(questionId)`.

- [ ] **Red:** raw wording/origin cannot be changed through link service; generated questions require `systemActor` and provenance; a lifecycle transition field in link input is rejected; human/generated origins remain distinguishable. Run targeted Vitest. **Expected failure:** link service missing.
- [ ] **Green:** delegate question creation/transition only to existing public repository commands, persist the orthogonal link separately, and never port the bundle Question `status` enum.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): link evidence provenance to questions"`.

### Task T-20-02: Implement the coverage-obligation ledger

**IDs:** Backlog `P2.M2.E1.T002`; bundle `T-20-02`

**Depends on:** T-20-01

**Files:**

- Create: `code/domain/ingest/coverage-obligation.ts`
- Create: `code/ingest/knowledge/obligation-service.ts`
- Create: `code/ingest/knowledge/obligation-service.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/obligation-service.test.ts`

**Interfaces:**

- Consumes: `QuestionId`, deterministic `IdGenerator`, append-only event writer.
- Produces: `ObligationStatus = "open"|"assigned"|"satisfied"|"terminal_gap"|"excluded"|"deferred"|"blocked"|"transferred"|"revoked"`; `CoverageObligation { id; questionId; trigger; ownerQuestionId; status; version }`; create/assign/transfer/resolve commands with expected version.

- [ ] **Red:** automatic branch without open owned obligation fails; two owners fail; budget pause maps to `blocked`, not `satisfied`; `deferred` is terminal for the obligation but does not mark its canonical question answered and does not block unrelated closure. Run targeted Vitest. **Expected failure:** obligation service missing.
- [ ] **Green:** implement one-owner transitions with optimistic versions; define terminal statuses as satisfied/terminal_gap/excluded/deferred/revoked and preserve QuestionRecord state independently.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): add finite coverage obligations"`.

### Task T-20-03: Gate generated-question admissibility and novelty

**IDs:** Backlog `P2.M2.E1.T003`; bundle `T-20-03`

**Depends on:** T-20-02

**Files:**

- Create: `code/ingest/knowledge/question-admissibility.ts`
- Create: `code/ingest/knowledge/question-admissibility.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/question-admissibility.test.ts`

**Interfaces:**

- Consumes: `CoverageObligation`, conservative lexical candidates, `IngestionQuestionLink`.
- Produces: `assessQuestionProposal(input): AdmissionDecision` where generated acceptance requires `triggerSourceUnitIds`, novel `obligationId`, concrete wording, and non-authoritative routing result; human questions always return `{admitted:true, kind:"demand"}`.

- [ ] **Red:** reject generic missingness, duplicate generated wording, and obligation-less child; admit unsupported human demand; admit generated child with trigger+novel obligation. Run targeted Vitest. **Expected failure:** admissibility export missing.
- [ ] **Green:** implement deterministic checks and treat lexical similarity as routing evidence only, never convergence or lifecycle authority.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): gate generated question novelty"`.

### Task T-21-01: Persist evidence packets and search receipts append-only

**IDs:** Backlog `P2.M2.E2.T001`; bundle `T-21-01`

**Depends on:** T-12-03, T-20-03

**Files:**

- Create: `code/domain/ingest/evidence-packet.ts`
- Create: `code/ingest/knowledge/evidence-service.ts`
- Create: `code/ingest/knowledge/evidence-service.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/evidence-service.test.ts`

**Interfaces:**

- Consumes: `SearchReceipt`, source hash verifier, Question link.
- Produces: `EvidenceReference { snapshotId;fileId;unitId;fileSha256;unitSha256;role;facetIds }`; `EvidencePacket { id;questionId;version;references;receiptId;limits }`; `EvidenceService.appendPacket(input)` and `.verifyReferences(packetId)`.

- [ ] **Red:** reject wrong snapshot/file/unit hash, overwrite of packet v1, and no-evidence packet without a healthy receipt; accept v2 as a new record. Run targeted Vitest. **Expected failure:** evidence service missing.
- [ ] **Green:** verify exact identities before append, derive packet id/version deterministically, and persist receipt linkage plus retrieval failures.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): persist evidence packets and receipts"`.

### Task T-21-02: Implement evidence verdict transitions

**IDs:** Backlog `P2.M2.E2.T002`; bundle `T-21-02`

**Depends on:** T-21-01

**Files:**

- Create: `code/domain/ingest/evidence-verdict.ts`
- Create: `code/ingest/knowledge/evidence-verdict-service.ts`
- Create: `code/ingest/knowledge/evidence-verdict-service.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/evidence-verdict-service.test.ts`

**Interfaces:**

- Consumes: verified `EvidencePacket`.
- Produces: `ReferenceClass = "material"|"supporting"|"irrelevant"|"obsolete"|"conflicting"`; `FacetState = "satisfied"|"unsatisfied"|"uncertain"`; `EvidenceVerdictState = "refine"|"accepted"|"no_supported_answer"|"search_incomplete"|"contradiction"`; append-only `EvidenceVerdict` and `EvidenceVerdictService.apply`.

- [ ] **Red:** accepted fails unless every required facet is satisfied and every material reference classified; `INDEX_UNAVAILABLE` cannot become `no_supported_answer`; contradiction returns a P1 activation command and `done:false`. Run targeted Vitest. **Expected failure:** verdict service missing.
- [ ] **Green:** validate verdict proposal, derive deterministic transition commands, and bypass future Curiosity Planner for contradictions.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): enforce evidence verdict lifecycle"`.

### Task T-21-03: Bound evidence refinement loops

**IDs:** Backlog `P2.M2.E2.T003`; bundle `T-21-03`

**Depends on:** T-21-02

**Files:**

- Create: `code/ingest/knowledge/evidence-loop-policy.ts`
- Create: `code/ingest/knowledge/evidence-loop-policy.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/evidence-loop-policy.test.ts`

**Interfaces:**

- Consumes: ordered packets/verdicts and policy budget.
- Produces: `evaluateEvidenceLoop(history, budget): "continue" | "search_incomplete" | "human_action"`; novelty key over query, filters, and requested facet.

- [ ] **Red:** repeated request and exhausted budget terminate without synthesising acceptance/no-evidence; a novel request continues; all packet/verdict IDs remain in terminal receipt. Run targeted Vitest. **Expected failure:** loop policy missing.
- [ ] **Green:** count refinements, compare novelty keys, and return deterministic terminal routing while retaining immutable history.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): bound evidence refinement loops"`.

### Task T-22-01: Implement one-file-per-claim repository and lifecycle

**IDs:** Backlog `P2.M2.E3.T001`; bundle `T-22-01`

**Depends on:** T-21-03

**Files:**

- Create: `code/domain/ingest/claim.ts`
- Create: `code/ingest/knowledge/claim-repository.ts`
- Create: `code/ingest/knowledge/claim-repository.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/claim-repository.test.ts`

**Interfaces:**

- Consumes: verified evidence references, Git-authoritative repository writer.
- Produces: `ClaimState = "proposed"|"accepted"|"disputed"|"stale"|"superseded"`; `Claim { id;text;type;scope;authority;lifecycle;state;evidence;relationships;version }`; `ClaimRepository.create/read/list/transition` using `ingest/claims/<claim-id>.json`.

- [ ] **Red:** acceptance without verified evidence, scope, authority, or lifecycle fails; source change marks affected claim stale; illegal transition and overwrite fail. Run targeted Vitest. **Expected failure:** claim repository missing.
- [ ] **Green:** validate transition table, atomically create one file per claim, append transition events, and expose only public repository commands.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): add Git-authoritative claim registry"`.

### Task T-22-02: Generate claim relationship candidates conservatively

**IDs:** Backlog `P2.M2.E3.T002`; bundle `T-22-02`

**Depends on:** T-22-01

**Files:**

- Create: `code/ingest/knowledge/claim-candidates.ts`
- Create: `code/ingest/knowledge/claim-candidates.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/claim-candidates.test.ts`

**Interfaces:**

- Consumes: claims and MiniSearch as disposable candidate index.
- Produces: `ClaimCandidate { left;right;relation:"equivalent"|"variant"|"broader"|"narrower"|"contradiction";signals:{text;scope;type;evidenceOverlap};score }`; `findClaimCandidates(claim, limit): readonly ClaimCandidate[]`.

- [ ] **Red:** same text/different scope is not exact equivalent; evidence overlap is reported but not decisive; labelled candidate recall denominator is measurable. Run targeted Vitest. **Expected failure:** candidate service missing.
- [ ] **Green:** generate only review candidates from typed signals, stable-sort them, and make no claim mutation or merge decision.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): find claim relationship candidates"`.

### Task T-22-03: Apply independent claim reviews idempotently

**IDs:** Backlog `P2.M2.E3.T003`; bundle `T-22-03`

**Depends on:** T-22-02

**Files:**

- Create: `code/domain/ingest/claim-review.ts`
- Create: `code/ingest/knowledge/claim-review-service.ts`
- Create: `code/ingest/knowledge/claim-review-service.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/claim-review-service.test.ts`

**Interfaces:**

- Consumes: proposed claim, `ClaimReview { reviewerRunId;claimId;decision:"accept"|"reject"|"qualify"|"split";... }`, idempotency key.
- Produces: `ClaimReviewService.apply(review, key): Promise<ClaimReviewApplication>` including accepted/rejected/split claim IDs and provenance links.

- [ ] **Red:** extractor run cannot review its own claim; retry creates one logical application; split preserves all evidence/provenance; rejected claim cannot be selected as accepted. Run targeted Vitest. **Expected failure:** review service missing.
- [ ] **Green:** enforce distinct run/role identity, expected claim version, transactional split writes, and accepted-state transition only through this service.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): apply independent claim reviews"`.

### Task T-23-01: Serialise graph mutations with versions and idempotency

**IDs:** Backlog `P2.M2.E4.T001`; bundle `T-23-01`

**Depends on:** WP-20 integration remediation (`P2.M2.E1.T004`), T-21-03, T-22-03

**Files:**

- Create: `code/domain/ingest/graph-event.ts`
- Create: `code/ingest/gateway/graph-gateway.ts`
- Create: `code/ingest/gateway/graph-gateway.test.ts`
- Create: `code/ingest/gateway/index.ts`
- Modify: `code/ingest/index.ts`
- Test: `code/ingest/gateway/graph-gateway.test.ts`

**Interfaces:**

- Consumes: validated entity commands and injected atomic event writer.
- Produces: `GraphGateway.apply(command:{expectedRevision:GraphRevision;idempotencyKey:string;operations:readonly GraphOperation[]}): Promise<IngestResult<GraphCommit,"STALE_REVISION"|"INVALID_EDGE"|"MISSING_ENTITY">>`.

- [ ] **Red:** two writes at revision 4 cause one success/one stale result; same idempotency key returns one commit; invalid entity/edge fails without event. Add authoritative generated-branch cases: caller-supplied/fabricated link, obligation, admitted-wording, or lexical facts cannot override repository state; rejected admission writes no question/link/obligation/event; a successful command atomically creates the canonical generated QuestionRecord, its `IngestionQuestionLink`, exactly one self-owned unresolved `CoverageObligation`, and one graph commit; concurrent/restarted retries expose either the whole prior result or no branch, never partial state. Run targeted Vitest. **Expected failure:** gateway missing.
- [ ] **Green:** lock the logical graph, reread authoritative question-link/obligation/admitted-wording state inside the transaction, assess the proposal, validate all operations, atomically create the generated question+link+obligation with one graph event, advance revision, and return the prior complete result for idempotent retries. Lower-level repositories/services remain infrastructure, not an automatic-branch entry point; human question creation remains on the canonical lifecycle path.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): serialise graph mutations"`.

### Task T-23-02: Build dependencies and deterministic SCCs

**IDs:** Backlog `P2.M2.E4.T002`; bundle `T-23-02`

**Depends on:** T-23-01

**Files:**

- Create: `code/ingest/gateway/dependency-graph.ts`
- Create: `code/ingest/gateway/dependency-graph.test.ts`
- Modify: `code/ingest/gateway/index.ts`
- Test: `code/ingest/gateway/dependency-graph.test.ts`

**Interfaces:**

- Consumes: graph events with source→evidence→claim→answer/document edges.
- Produces: `DependencyGraph.dependenciesOf(id): readonly string[]`, `.condensed(): readonly StrongComponent[]`, `.readiness(id): IngestResult<"ready","MISSING_DEPENDENCY">`.

- [ ] **Red:** literal cyclic fixture condenses into sorted SCCs; every artifact reports IDs; missing dependency blocks readiness. Run targeted Vitest. **Expected failure:** dependency graph missing.
- [ ] **Green:** replay events into a local projection, use deterministic Tarjan traversal over sorted IDs, and rebuild from events.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): project dependency graph and SCCs"`.

### Task T-23-03: Propagate precise invalidation

**IDs:** Backlog `P2.M2.E4.T003`; bundle `T-23-03`

**Depends on:** T-23-02

**Files:**

- Create: `code/ingest/gateway/invalidation-service.ts`
- Create: `code/ingest/gateway/invalidation-service.test.ts`
- Modify: `code/ingest/gateway/index.ts`
- Test: `code/ingest/gateway/invalidation-service.test.ts`

**Interfaces:**

- Consumes: dependency graph and mutation event.
- Produces: `InvalidationService.plan(event): InvalidationPlan { roots;stalePacketIds;staleClaimIds;staleCompositionIds;staleDocumentIds;staleFixtureIds;staleCertificateIds }`; `.apply(plan,key): GraphCommit`.

- [ ] **Red:** mutation cases invalidate all and only labelled descendants; human-curiosity and dedup-revocation events propagate; stale composition fails readiness. Run targeted Vitest. **Expected failure:** invalidation service missing.
- [ ] **Green:** traverse condensed dependencies from changed roots, stable-sort typed outputs, and apply stale transitions through graph/repository commands only.
- [ ] **Pass:** targeted Vitest passes; run `VITEST_MAX_THREADS=2 pnpm check` for the M2 gate.
- [ ] **Commit:** `git commit -m "feat(ingest): propagate dependency invalidation"`.

---

## R1 / M3 — measured vertical slice

### Task T-30-01: Expose policy-filtered Researcher source tools

**IDs:** Backlog `P2.M3.E1.T001`; bundle `T-30-01`

**Depends on:** T-12-03, T-13-02, T-21-03, T-02-03

**Files:**

- Create: `code/ingest/agents/researcher-tools.ts`
- Create: `code/ingest/agents/researcher-tools.test.ts`
- Create: `code/ingest/agents/index.ts`
- Modify: `code/ingest/index.ts`
- Test: `code/ingest/agents/researcher-tools.test.ts`

**Interfaces:**

- Consumes: exact map, lexical retrieval, policy gate, graph follow, authority lookup.
- Produces: `ResearcherTools = { exactLookup; lexicalSearch; openUnit; followLinks; authoritySearch }`; every result includes `ToolReceipt {snapshotId,indexVersion,filters,candidateIds,selectedIds}`; no tool accepts instructions from source text.

- [ ] **Red:** every tool call emits required receipt fields, unauthorised text never reaches output, and prompt-like source text cannot add tools/change limits. Run targeted Vitest. **Expected failure:** researcher-tools module missing.
- [ ] **Green:** create bounded adapters over public retrieval/policy seams, validate arguments, and return data-only source views.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): expose bounded researcher tools"`.

### Task T-30-02: Implement the Researcher contract and fixtures

**IDs:** Backlog `P2.M3.E1.T002`; bundle `T-30-02`

**Depends on:** T-30-01

**Files:**

- Create: `scaffold/agents/researcher/{agent.md,schema.json,fixtures/valid.json,fixtures/invalid-answer.json,fixtures/invalid-child.json}`
- Create: `code/ingest/agents/researcher-agent.ts`
- Create: `code/ingest/agents/researcher-agent.test.ts`
- Modify: `code/ingest/agents/index.ts`
- Test: `code/ingest/agents/researcher-agent.test.ts`

**Interfaces:**

- Consumes: question/facets, `ResearcherTools`, fresh provider call through existing agent runtime.
- Produces: `ResearcherProposal { questionId;packet:{references;facetSupport;limits};receiptIds;outcome:"packet"|"no_evidence" }`; `runResearcher(input): Promise<ResearcherProposal>`.

- [ ] **Red:** schema rejects final answer prose and child proposals; no-evidence without sufficient healthy receipt fails; valid minimal complete references pass. Run targeted Vitest. **Expected failure:** researcher scaffold/agent missing.
- [ ] **Green:** author repo-native agent definition/schema and paired fixtures, register role/input policy, validate output before EvidenceService writes it.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(agents): add evidence-only researcher"`.

### Task T-30-03: Calibrate retrieval policy (optional, non-gating)

**IDs:** Backlog `P2.M3.E1.T003`; bundle `T-30-03`

**Depends on:** T-30-02; **no downstream task may depend on this task**

**Files:**

- Create: `code/integration/researcher-calibration.ts`
- Create: `code/integration/researcher-calibration.test.ts`
- Create: `docs/engineering/researcher-retrieval-profile.md`
- Test: `code/integration/researcher-calibration.test.ts`

**Interfaces:**

- Consumes: cached-disabled tiny/small Researcher fixture outputs.
- Produces: `RetrievalProfile { maxCandidates;maxOpenedUnits;queryExpansion;rerank:false;version }` and report by question type.

- [ ] **Red:** worked fixtures require recall, precision, false-no-evidence, latency, and cost by question type and a replay diff on profile change. Run targeted Vitest. **Expected failure:** calibration module missing.
- [ ] **Green:** implement offline scoring and commit conservative literal limits; no production task imports the report.
- [ ] **Pass:** targeted Vitest passes. Failure or omission does not block M3.
- [ ] **Commit:** `git commit -m "chore(ingest): calibrate researcher retrieval"`.

### Task T-31-01: Implement the isolated Evidence Critic contract

**IDs:** Backlog `P2.M3.E2.T001`; bundle `T-31-01`

**Depends on:** T-21-03, T-30-02, T-02-03 (not T-30-03)

**Files:**

- Create: `scaffold/agents/evidence-critic/{agent.md,schema.json,fixtures/valid.json,fixtures/invalid-child.json}`
- Create: `code/ingest/agents/evidence-critic-agent.ts`
- Create: `code/ingest/agents/evidence-critic-agent.test.ts`
- Modify: `code/ingest/agents/index.ts`
- Test: `code/ingest/agents/evidence-critic-agent.test.ts`

**Interfaces:**

- Consumes: verbatim question/facets, packet references, only `open_reference(referenceId): Promise<BoundedReferenceView>`, fresh provider call.
- Produces: `EvidenceCriticProposal { referenceClassifications;facetStates;verdict;refinement?;depthFindings? }`; explicitly no child-question field.

- [ ] **Red:** schema rejects child proposals; runtime test proves a new provider-call ID and only allowed input/tool context; accepted output must classify every material reference/facet and preserve qualifiers. Run targeted Vitest. **Expected failure:** critic scaffold/agent missing.
- [ ] **Green:** author schema/prompt, register a fresh evaluator invocation, expose only `open_reference`, and send validated output to EvidenceVerdictService.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(agents): add isolated evidence critic"`.

### Task T-31-02: Build decisive evidence-criticism fixtures

**IDs:** Backlog `P2.M3.E2.T002`; bundle `T-31-02`

**Depends on:** T-31-01

**Files:**

- Create: `scaffold/agents/evidence-critic/fixtures/{partial,irrelevant,redundant,wrong-scope,deprecation,conflict,no-evidence,prompt-injection}.json`
- Create: `code/integration/evidence-critic-fixtures.test.ts`
- Test: `code/integration/evidence-critic-fixtures.test.ts`

**Interfaces:**

- Consumes: Evidence Critic public agent seam and deterministic fake cases.
- Produces: versioned regression cases and `EvidenceCriticThresholds { weakPacketAcceptance:0; completeMinimalAcceptance:1; injectionRoleChanges:0 }`.

- [ ] **Red:** add fixtures first and assert exact verdict/classification literals; run targeted Vitest. **Expected failure:** fake provider reports unregistered fixture case.
- [ ] **Green:** register deterministic fake outputs that validate against the production schema and adjust prompt contract only until weak packets reject, complete minimal packets pass, and injection cannot alter role.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "test(agents): cover evidence critic failures"`.

### Task T-31-03: Run combined-versus-split ablation (optional, non-gating)

**IDs:** Backlog `P2.M3.E2.T003`; bundle `T-31-03`

**Depends on:** T-31-02; **no downstream task may depend on this task**

**Files:**

- Create: `code/integration/evidence-role-ablation.ts`
- Create: `code/integration/evidence-role-ablation.test.ts`
- Create: `docs/engineering/evidence-role-ablation.md`
- Test: `code/integration/evidence-role-ablation.test.ts`

**Interfaces:**

- Consumes: recorded split-role and combined-baseline fixture result JSON.
- Produces: `AblationResult { falseAcceptance;refinementQuality;branchFactor;costAud;outputStability;decision:"retain-split"|"revisit" }`.

- [ ] **Red:** worked input must calculate exact metrics and reject reports without matching corpus/model/prompt versions. Run targeted Vitest. **Expected failure:** ablation module missing.
- [ ] **Green:** implement offline comparison and document the falsifiable decision; do not add a combined role to production.
- [ ] **Pass:** targeted Vitest passes. Failure or omission does not block T-32-01/T-60-01 or M3.
- [ ] **Commit:** `git commit -m "chore(ingest): compare evidence role split"`.

### Task T-32-01: Implement the Claim Extractor proposal agent

**IDs:** Backlog `P2.M3.E3.T001`; bundle `T-32-01`

**Depends on:** T-22-03, T-31-02

**Files:**

- Create: `scaffold/agents/claim-extractor/{agent.md,schema.json,fixtures/valid.json,fixtures/invalid-generalisation.json}`
- Create: `code/ingest/agents/claim-extractor-agent.ts`
- Create: `code/ingest/agents/claim-extractor-agent.test.ts`
- Modify: `code/ingest/agents/index.ts`
- Test: `code/ingest/agents/claim-extractor-agent.test.ts`

**Interfaces:**

- Consumes: accepted evidence verdict/packet only; claim candidate read results.
- Produces: `ClaimProposal { text;type;scope;authority;lifecycle;evidenceReferenceIds;candidateRelationships }[]`; no state/ID/write authority.

- [ ] **Red:** fixture rejects universal claim inferred from example, inferred intent labelled as documented rationale, and evidence outside accepted packet. Run targeted Vitest. **Expected failure:** extractor scaffold/agent missing.
- [ ] **Green:** author schema/prompt and runtime adapter; deterministic service assigns IDs and persists all outputs as `proposed` only.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(agents): propose qualifier-preserving claims"`.

### Task T-32-02: Implement the fresh-context Claim Reviewer

**IDs:** Backlog `P2.M3.E3.T002`; bundle `T-32-02`

**Depends on:** T-32-01

**Files:**

- Create: `scaffold/agents/claim-reviewer/{agent.md,schema.json,fixtures/valid.json,fixtures/reject-overbroad.json,fixtures/split.json}`
- Create: `code/ingest/agents/claim-reviewer-agent.ts`
- Create: `code/ingest/agents/claim-reviewer-agent.test.ts`
- Modify: `code/ingest/agents/index.ts`
- Test: `code/ingest/agents/claim-reviewer-agent.test.ts`

**Interfaces:**

- Consumes: proposed claim, exact evidence text, relationship candidates, fresh provider call; never extractor transcript/context.
- Produces: `ClaimReviewProposal { decision;entailment;atomicity;scope;qualifiers;authorityEligible;splits? }`, applied only by ClaimReviewService.

- [ ] **Red:** overgeneralisation rejects, overbroad claim splits with evidence provenance, provider-call ID differs from extractor and input excludes extractor messages. Run targeted Vitest. **Expected failure:** reviewer scaffold/agent missing.
- [ ] **Green:** author fresh evaluator policy/schema and adapter; validate before deterministic review application.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(agents): review claims in fresh context"`.

### Task T-32-03: Calibrate reusable claim granularity

**IDs:** Backlog `P2.M3.E3.T003`; bundle `T-32-03`

**Depends on:** T-32-02

**Files:**

- Create: `code/integration/claim-granularity.test.ts`
- Create: `code/integration/fixtures/claim-granularity.json`
- Create: `docs/engineering/claim-granularity-guide.md`
- Test: `code/integration/claim-granularity.test.ts`

**Interfaces:**

- Consumes: reviewed pilot claims and two-question reuse labels.
- Produces: `ClaimGranularityMetrics { reuseRate;fragmentationRate;reviewerAgreement }` and normative rules for procedures/preconditions/interface ordering.

- [ ] **Red:** assert one accepted claim is reused by two questions, procedure steps/preconditions remain ordered, and reviewer agreement is calculated from literal labels. Run targeted Vitest. **Expected failure:** fixture/guide missing.
- [ ] **Green:** author labels and concise rules that distinguish atomicity from fragmentation; derive metrics without changing agent runtime.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "docs(ingest): calibrate claim granularity"`.

### Task T-60-01: Build reproducible sealed claim packs

**IDs:** Backlog `P2.M3.E4.T001`; bundle `T-60-01`

**Depends on:** T-22-03, T-23-03, T-31-02, T-32-02 (not T-31-03)

**Files:**

- Create: `code/domain/ingest/sealed-claim-pack.ts`
- Create: `code/ingest/knowledge/claim-pack-service.ts`
- Create: `code/ingest/knowledge/claim-pack-service.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Test: `code/ingest/knowledge/claim-pack-service.test.ts`

**Interfaces:**

- Consumes: accepted ClaimReview applications, dependency graph revision, question goals/facets.
- Produces: `SealedClaimPack { hash:Sha256;questionId;graphRevision;claimIds;claims;qualifierEdges;citations;gaps }`; `ClaimPackService.build(questionId, revision): IngestResult<SealedClaimPack,"UNACCEPTED_CLAIM"|"STALE_CLAIM"|"MISSING_QUALIFIER">`.

- [ ] **Red:** proposed/stale claim is excluded with error, required qualifier dependency is included, and identical logical input in different order yields identical hash/bytes. Run targeted Vitest. **Expected failure:** pack service missing.
- [ ] **Green:** select only accepted independently reviewed claims, close required qualifier edges, stable-sort/serialise, and content-address the sealed result.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(ingest): seal accepted claim packs"`.

### Task T-60-02: Compose answers only from sealed claims

**IDs:** Backlog `P2.M3.E4.T002`; bundle `T-60-02`

**Depends on:** T-60-01

**Files:**

- Create: `code/domain/ingest/answer-composition.ts`
- Create: `scaffold/agents/answer-composer/{agent.md,schema.json,fixtures/valid.json,fixtures/insufficient.json,fixtures/invalid-unmapped.json}`
- Create: `code/ingest/agents/answer-composer-agent.ts`
- Create: `code/ingest/agents/answer-composer-agent.test.ts`
- Modify: `code/ingest/agents/index.ts`
- Test: `code/ingest/agents/answer-composer-agent.test.ts`

**Interfaces:**

- Consumes: `SealedClaimPack`, question goals; no retrieval/open-source tools.
- Produces: `AnswerComposition { id;questionId;claimPackHash;graphRevision;answer;claimOrder;sentenceClaims;citations;goalCoverage;limitations;state:"proposed"|"insufficient_pack" }`; explicit `StructuredAnswerCompatibility.readQuestionContext(questionId)` read-only adapter.

- [ ] **Red:** manifest with retrieval tool fails; unmapped material assertion fails schema/application; shared claims produce distinct compositions for two goal sets; insufficient pack returns no invented prose. Run targeted Vitest. **Expected failure:** composer scaffold/agent missing.
- [ ] **Green:** author no-tool composer policy/schema, validate every sentence mapping, persist a distinct composition record, and read transcript Structured answer only as labelled question context—not as an ingestion composition.
- [ ] **Pass:** targeted Vitest passes.
- [ ] **Commit:** `git commit -m "feat(agents): compose answers from sealed claims"`.

### Task T-60-03: Review answer citations, graph validity, and R1 replay

**IDs:** Backlog `P2.M3.E4.T003`; bundle `T-60-03`

**Depends on:** T-60-02, T-32-03

**Files:**

- Create: `code/ingest/knowledge/answer-validity.ts`
- Create: `code/ingest/knowledge/answer-validity.test.ts`
- Create: `code/integration/automatic-ingestion-r1.test.ts`
- Modify: `code/ingest/knowledge/index.ts`
- Modify: `code/integration/ingest-fixture-runner.ts`
- Test: `code/ingest/knowledge/answer-validity.test.ts`
- Test: `code/integration/automatic-ingestion-r1.test.ts`

**Interfaces:**

- Consumes: `AnswerComposition`, sealed pack, current graph revision, source/claim hashes, tiny/small fixture runner.
- Produces: `reviewAnswerComposition(input): AnswerValidity { promotable;unsupportedSentenceIds;staleDependencies;revisionMatch }`; R1 acceptance result covering AS-01..AS-04 with cache disabled.

- [ ] **Red:** unsupported synthesis, stale revision, and changed source/claim hash each set `promotable:false`; run the full tiny/small zero-cache fixture and observe absent validity service/R1 pipeline. Run `pnpm exec vitest run code/ingest/knowledge/answer-validity.test.ts code/integration/automatic-ingestion-r1.test.ts --maxWorkers=2`. **Expected failure:** answer-validity module missing and R1 scenarios report `not_implemented`.
- [ ] **Green:** verify sentence→claim→citation closure, exact pack/dependency hashes, and current graph revision; make the fixture runner blocking for R1 and execute snapshot→extract→unitize→retrieve→packet→fresh critic→fresh claim review→sealed pack→composition on both corpora. Assert contradictions create active P1 work and prevent `done`, while unsupported healthy searches remain explicit no-supported-answer outcomes without fabricated claims.
- [ ] **Pass:** run the two-file Vitest command; expect AS-01..AS-04 green on tiny+small with cache disabled. Then run `VITEST_MAX_THREADS=2 pnpm check`; expect exit 0. Finally run `python3 docs/specs/automatic-ingestion-v3/source-bundle/tools/validate_bundle.py`; expect exit 0, proving the inert bundle remained byte-preserved.
- [ ] **Commit:** `git commit -m "feat(ingest): validate R1 answer compositions"`.

## Milestone and release gates

- **M0:** T-00-01 through T-02-03 and synthetic T-01-04 pass; architecture/contracts/lab are reviewed; `VITEST_MAX_THREADS=2 pnpm check` exits 0.
- **M1:** executable core tasks T-10-01 through T-13-03 pass, excluding blocked T-10-04. T-12-04 is reported if run but cannot gate. Replay recovery and immutable-write rejection pass; T-10-04 deletion remains unimplemented and cannot gate M1: it is blocked until an accepted ADR AND ratified D9 AND every capability gate; acceptance alone unlocks no work.
- **M2:** T-20-01 through T-23-03 pass; canonical Question lifecycle tests, deferred-obligation semantics, contradiction P1 routing, claim review isolation, and targeted invalidation are green.
- **M3 / R1 internal release:** core T-30-01, T-30-02, T-31-01, T-31-02, T-32-01..03, T-60-01..03 pass. T-30-03 and T-31-03 cannot gate. AS-01..AS-04 pass on tiny and small corpora with provider cache disabled, all evaluator call IDs prove fresh isolation, `pnpm check` exits 0 with two-thread test limits, and the preserved bundle validator still exits 0.

--- SUMMARY ---

- **48 planned tasks, 47 currently executable slices:** all 46 R0/R1 bundle leaves, synthetic T-01-04, and synthetic C12 split T-10-04 are task-granular. T-10-04 remains blocked and non-executable until an accepted ADR AND ratified D9 AND every capability gate (acceptance alone unlocks no work); each other task has exact paths, public TypeScript contracts, a named failing test and expected failure, minimal green implementation, pass command, and commit message.
- **R0:** locks architecture/seams/change control, adds curated Zod contracts and manifest/link validation, defines the minimum policy prerequisite, and creates measurable tiny/small zero-cache fixtures.
- **R1 source plane:** preflights without extraction, stores immutable snapshots/replay capsules, supports deterministic A-tier representations and repairs-as-new-versions, structural units, MiniSearch receipts, and policy filtering/scanning. The source bundle remains inert; vectors remain offline-only; custody deletion is not implemented, and is blocked until an accepted ADR AND ratified D9 AND every capability gate; acceptance alone unlocks no work.
- **R1 knowledge plane:** links provenance to the existing canonical QuestionRecord without a second lifecycle, owns finite obligations (including explicit deferred semantics), persists append-only evidence/verdict/claim records, requires independent claim review, and serialises graph mutation/invalidation through deterministic services.
- **R1 agent/answer plane:** Researcher proposes evidence only; fresh Evidence Critic cannot propose children; fresh Claim Reviewer cannot inherit extractor context; Answer Composer has no retrieval tools and writes a distinct AnswerComposition from a reproducible sealed accepted-claim pack.
- **Gate discipline:** T-12-04, T-30-03, and T-31-03 are optional and non-gating; two-worker Vitest and `pnpm check` are mandatory; AS-01..AS-04 and zero-cache tiny/small replay form the M3 internal-release gate; later publication must reuse the existing actual-diff change-request lane.
