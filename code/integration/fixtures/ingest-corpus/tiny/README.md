# Tiny labelled ingestion corpus

Fixture provenance: this corpus is a curated adaptation of the preserved inert samples at `docs/specs/automatic-ingestion-v3/source-bundle/examples/source-corpus/{architecture,api,legacy,maintenance-note,operations}.md`. It is copied and rewritten here as test data; tests never import or resolve the preserved source bundle at runtime. Exact source paths and sections are recorded in `expected-graph.json`.

The labels are hand-authored evaluation truth, not generated output. Source bytes and paths are immutable inputs whose SHA-256 digests are recorded in `expected-graph.json`.
