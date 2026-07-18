# Dependency Map

The rendered dependency graph is `dependency-graph.svg`; the editable source is `dependency-graph.dot`.

## Critical path

```text
WP-00 → WP-01 → WP-02
  → WP-10 → WP-11 → WP-12
  → WP-20 → WP-21 → WP-22 → WP-23
  → WP-30 → WP-31 → WP-32 → WP-60
  → WP-33 → WP-40/WP-41 → WP-42
  → WP-50/WP-51 → WP-52
  → WP-61 → WP-62 → WP-63
  → WP-70/WP-71/WP-72
  → WP-80 → WP-81 → WP-82
```

Security policy work (`WP-13`) begins beside source intake and is a dependency for authority/publication. Evaluation (`WP-02`, `WP-80`) is continuous rather than a final-phase afterthought.
