# Validation Report

**Result:** PASS

```text
OK: validated 223 files
- schemas: 27
- agents: 15
- workflows: 11
- example records: 42
- work packages: 31
- leaf tasks: 95
- diagrams: 8
```

## Checks performed

- Every JSON and YAML artifact parses.
- All JSON Schemas are valid Draft 2020-12 schemas.
- Every agent manifest validates and references an existing output schema and fixture.
- The v3 role boundary is enforced structurally: `EvidenceVerdict` has no child-question field, while `CuriosityPlan` has no evidence-verdict or facet-state field.
- Every workflow validates; agent/subworkflow references and state transitions resolve; all steps are reachable.
- Forty-two example records validate against their declared schemas.
- Synthetic source-file, source-unit, line-range, file-hash, unit-hash, evidence-reference, and claim-reference integrity checks pass.
- All example claim/question/answer/obligation cross-references resolve.
- Thirty-one work packages and ninety-five leaf tasks validate.
- Work-package and task dependencies exist and are acyclic.
- The flattened `task-index.jsonl` exactly matches the hierarchical task files.
- Every DOT architecture diagram has matching Mermaid source and SVG rendering.
- The plan dependency graph is rendered.
- Relative Markdown links resolve inside the bundle.
- Supplied source-document copies match `source/source-manifest.yaml`.
- `MANIFEST.sha256` lists and verifies every substantive bundle file; it intentionally excludes itself and this report.
- No committed database, vector index, compressed archive, media blob, bytecode cache, or other forbidden derived artifact exists inside the bundle.

## What this validation does not prove

The report proves internal package consistency. It does not prove that a future implementation reaches the proposed quality, cost, security, or human-utility thresholds. Those require the staged corpus experiments and acceptance gates in `11-testing-and-rollout.md` and `plan/`.
