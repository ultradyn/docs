# Import Receipt — Automatic Ingestion v3 Design Bundle

- **Original artifact:** `ingest-feature-v3.zip` (supplied by Max, 2026-07-18, at `/home/xertrov/Downloads/ingest-feature-v3.zip`; ZIP itself intentionally not committed)
- **ZIP SHA-256:** `b10d4c05fff780ab0fe10d7487a0a316f56fc88514df6654cca7ea328e542e6e`
- **Imported:** 2026-07-18 (AEST) by claude-pivot-cotton-27tq, joint-locked with pi-73c593
- **Contents:** all 223 extracted regular files, byte-identical, under `source-bundle/` (ZIP's 238 entries = 223 files + 15 directory entries)
- **Exclusions:** none (earlier curated-subset proposal was rejected in joint review because `tools/validate_bundle.py` requires diagram renders and MANIFEST.sha256 covers them)

## Verification at import

- `MANIFEST.sha256`: 221/221 hashes OK (covers every file except itself and `VALIDATION.md`, both written after hashing)
- `python3 tools/validate_bundle.py` run from the committed `source-bundle/`: **PASS, exit 0** — 223 files; 27 schemas; 15 agents; 11 workflows; 42 example records; 31 work packages; 95 leaf tasks; 8 diagrams
- Independent extraction + inventory cross-check by pi-73c593 (223 files, 686,183 bytes; no traversal/symlink/encryption hazards)

## Provenance rules

- Files under `source-bundle/` are **immutable imported provenance**: never edit, reformat, or rename them. A superseding drop gets a new sibling directory with its own receipt.
- The bundle uses the product's **former name "Docent"**; the current canonical name is **Ultradyn Docs** (confirmed by Max, 2026-07-18). Newly authored adoption docs, backlog entries, and code use Ultradyn Docs terminology; the mapping is recorded in the adoption doc and ADR-0005.
- Adoption decisions, conflict resolutions, and the implementation decomposition live OUTSIDE the bundle: see `DESIGN.md` (this directory), `docs/adr/0005-*.md`, `docs/adr/0006-*.md`, and `.plan/07-automatic-ingestion-v3.md`.
