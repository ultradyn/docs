# Automatic Ingestion v3 — R0/R1 Implementation Plan

Scope: bundle milestones M0–M3 (backlog phases P1–P2; 47 atomic tasks). Written before any implementation per the locked process (DESIGN.md §8). Execution truth is the backlog; this plan tells implementers HOW, in repo terms. Elaboration rule: Wave 1 (M0) is planned to task granularity here; M1–M3 sections are planned to contract granularity and are elaborated to task granularity at each milestone gate, appended to this document in the same format.

## Ground rules (apply to every task)

- Worktree per slice under `.worktrees/`; `bl claim` **in the main checkout** (bl refuses mutations from worktrees) → commit claim → worktree from the claim tip → implement → parent review → merge → `bl done` in the main checkout.
- TDD at pre-agreed seams only. New seams MUST be proposed in `docs/engineering/tdd-seams.md` in the same change that first tests them; never mock internal modules.
- `pnpm check` green before any merge. Limit builds/tests to 2 threads.
- Deterministic services own IDs/writes/state; agents only propose (ADR 0001/0005). Nothing under `docs/specs/automatic-ingestion-v3/source-bundle/` is imported at runtime (N8).
- Every commit body references its backlog ID and bundle task ID.

## Module layout (fixed for R0/R1)

- `code/ingest/` — new deep module, one public `index.ts`; submodules `source/` (snapshot, extraction, units), `retrieval/`, `knowledge/` (question-mapping, obligation, evidence, claim), `gateway/` (graph/validity), `policy/`.
- `code/domain/ingest/` — record contracts (Zod-first; see D-dialect below) + `registerIngestSchemas()` called from the single existing registration point in `code/domain/schemas.ts` (one hot-file edit, batched task).
- `scaffold/agents/<researcher|evidence-critic|claim-extractor|claim-reviewer|answer-composer>/` — `agent.md` + `schema.json` + paired fixtures, curated adaptations of the bundle YAML (never direct imports).
- `tests/` colocated per repo convention; corpus lab fixtures under `code/integration/fixtures/ingest-corpus/{tiny,small}/`.

**D-dialect decision (N7, taken now):** contracts are authored in Zod (repo-native) as the source of truth; JSON-Schema is emitted for portable validation via the existing portable-schema validator. E-01 includes dialect fixtures proving Draft-2020-12 rejection cases behave identically in the emitted schemas. If emission proves lossy for a construct, fall back per-record to Ajv2020 with an ADR note — do not silently mix dialects.

## Wave 1 — M0 (parallel slices; zero shared files except the named batch task)

### E-01 Schema and validation toolchain (slice S2; owner A)

1. **T-01-01 record-contract port (first tranche: source plane).** Files: `code/domain/ingest/{source-snapshot,source-file,source-unit,search-receipt}.ts` + tests. RED: fixture-driven parse/reject tests from `source-bundle/examples/records/*.yaml` (valid) plus mutated invalids (wrong hash length, missing required, extra property — `additionalProperties:false` parity). GREEN: Zod contracts. Verify: examples parse byte-faithfully.
2. **T-01-02 second tranche (knowledge plane):** question-mapping (N6: system-actor + provenance mapping type, NOT the bundle Question schema), coverage-obligation (C11: explicit `deferred` disposition decision — add `deferred` to the disposition union, with tests proving deferred neither satisfies closure nor blocks), evidence-packet, evidence-verdict, claim, claim-review, answer-composition (C15 distinct record + adapter test against `answers/structured.md` fixtures).
3. **T-01-03 validation harness:** `registerIngestSchemas()` + emitted JSON-Schema round-trip + dialect fixtures (N7) + `pnpm check` wiring.
4. **T-01-04 policy-profile contract (N3):** minimal profile shape + validation + fixture; unblocks WP-10 preflight and WP-13.

### E-02 Eval baseline and corpus lab (slice S3; owner B)

1. **T-02-01 corpus import:** curate `tiny` corpus from `source-bundle/examples/source-corpus/` (copied as fixtures — allowed: fixtures are curated adaptations, tagged with provenance) + author `small` corpus from this repo's own docs subset.
2. **T-02-02 labeled expectations:** per-corpus expected units/questions/claims as fixtures.
3. **T-02-03 fixture runner:** vitest harness that replays labeled corpora against (initially absent) services and reports coverage; wired into `pnpm check` as a non-blocking report until M1 lands.

### E-00 Architecture baseline (docs residue; folded into S1/parent)

1. **T-00-01 decision log:** already materially done by DESIGN.md/ADR 0005-0006; task closes by linking them + porting the two most load-bearing diagrams (.mmd) into `docs/architecture.md` with Ultradyn Docs names.
2. **T-00-02/03:** completion predicate + deferred-features register cross-check against IDEA_REGISTER; outputs land in DESIGN.md addenda.

**Shared-file batch task:** the single `code/domain/schemas.ts` registration edit + any `vitest.config.ts`/`pnpm check` wiring happens once, in E-01 T-01-03, after S2/S3 content lands. S3 must not touch those files.

## M1 — Deterministic source plane (contract granularity)

- **WP-10 intake:** `SourceSnapshotService.create/verify_replay` per `source-bundle/16-runtime-interfaces.md` §1; content-addressed replay capsule in the machine-local data dir (append-only; raw custody per ADR 0001). Preflight (T-10-01) consumes the N3 policy-profile contract; rejects traversal/link-escape/decompression-bomb before extraction (FR-SRC-004) — reuse the repo's existing no-follow/symlink-rejection primitives from the audio/raw-artifact path rather than new ones.
- **WP-11 extraction:** A-tier Markdown/text only (D3); representation audit (T-11-02) is the dependency for unitization (N4), repair path (T-11-03) creates new immutable representations.
- **WP-12 units/retrieval:** structural parser → `SourceUnit` records; exact maps/aliases; MiniSearch lexical index with SEARCH RECEIPTS. N5: this is new behavior — do not extend `code/server/retrieval.ts`; build `code/ingest/retrieval/` and leave existing product retrieval untouched. Service failure ≠ corpus absence (FR-RET-005) is a named test.
- **WP-13 policy:** full profile enforcement at retrieval/model boundaries (dep: lexical retrieval, N4) + secret/PII scan hooks.
- Seams to propose in `docs/engineering/tdd-seams.md` at M1 start: snapshot store, extractor, unit parser, retrieval index, policy gate.

## M2 — Knowledge core (contract granularity)

- **WP-20 questions/obligations:** ingestion-lane question mapping keeps `question.md.state` canonical (C9/C13); obligations with the C11 `deferred` semantics; system-actor provenance (N6).
- **WP-21 evidence:** packet + verdict stores, idempotency keys, versioned refinement requests.
- **WP-22 claims:** one file per claim (D10) in the Git-authoritative layout; proposed/accepted separation (FR-CLM-004/005).
- **WP-23 gateway:** `graph.apply` with expected version + idempotency key; validity checks; projections via filesystem/durable-cursor behind the projection interface (D4). Agents never touch files directly.

## M3 — Measured vertical slice (contract granularity)

- **WP-30 Researcher / WP-31 Evidence Critic / WP-32 Extractor+Reviewer:** scaffold agent definitions + input policies in `code/agents/runtime.ts` conventions; Critic gets only `open_reference` + bounded context (16 §2); role split enforced by output schemas (no child proposals in Critic output — schema test). Optional calibration/ablation tasks (T-30-03/T-31-03) are tagged optional and never block (N2).
- **WP-60 answer composition:** sealed claim-pack builder (deps: accepted claim reviews — N1), Answer Composer with NO retrieval tools (FR-ANS-001), citation/validity review. `AnswerComposition` record distinct from Structured answer (C15).
- **M3 exit = R1 internal release gate:** AS-01..AS-04 acceptance scenarios pass on tiny+small corpora with zero-cache replay; fixture runner from E-02 flips to blocking in `pnpm check`.

## Verification protocol (every wave)

1. `pnpm check` (2 threads).
2. `python3 docs/specs/automatic-ingestion-v3/source-bundle/tools/validate_bundle.py` still passes (bundle untouched).
3. `backlog check` clean; claimed/done states match reality.
4. Milestone gates additionally run the labeled-corpus fixture report and require the bundle's per-WP acceptance gates (cited in each task body).

--- SUMMARY ---

- Wave 1 (M0) runs now as two zero-overlap parallel slices — E-01 contracts (Zod-first with 2020-12 dialect fixtures; includes the N3 policy contract and C11/C15/N6 decisions as tests) and E-02 corpus lab (tiny/small labeled corpora + replay fixture runner) — plus a docs-residue E-00 task; the single hot-file registration edit is batched into T-01-03.
- M1–M3 are planned at contract granularity against the bundle's runtime interfaces, with the load-bearing repo adaptations pinned: new `code/ingest/` module (existing retrieval untouched, N5), reuse of existing no-follow/raw-custody primitives, one-file-per-claim Git layout, filesystem projections behind an interface, agents as scaffold curated adaptations with schema-enforced role split.
- Task-granularity elaboration for M1/M2/M3 is appended at each milestone gate; M3 exit is the R1 release gate (AS-01..04, zero-cache replay, fixture runner blocking).
