---
name: web-artisan-terra
description: Tight, evidence-driven atelier workflow for GPT-5.6 Terra to build excellent websites without context drift or waste.
disable-model-invocation: true
---

# Web Artisan — GPT-5.6 Terra

Run the sibling `web-artisan-core` skill as an **atelier**: short artifacts, early decisions, small slices, and observable checks.

## Terra profile

Terra is strongest when the source of truth is compact and settled. Do not keep art direction open during implementation. Use medium reasoning as the normal setting; escalate only for a named hard decision or final visual delta.

## Atelier sequence

1. Read `../web-artisan-core/SKILL.md` and only the references required by the selected mode.
2. Inspect the smallest authoritative set of repository files, visual sources, and representative states. Record them so they are not repeatedly rediscovered.
3. Establish a concise `PRODUCT.md` and classify the mode.
4. Produce **two quick structural sketches**. They must differ in hierarchy and primary affordance. Select one immediately using the core rubric.
5. Freeze a compact `DESIGN.md`, `STATE-MATRIX.md`, and semantic light/dark token plan. Mark settled decisions.
6. Create a slice list of 3–7 user-visible slices. Work on exactly one slice at a time.
7. Before each slice, reread the relevant `DESIGN.md` section and current open visual deltas; do not re-scan the whole repository without evidence that context changed.
8. Render every slice. Run **three visual passes** by default: structure/hierarchy, responsive/themes, then polish/states. Add another pass only for an observed P0/P1 defect.
9. Run targeted validation and a short independent standards/spec review.
10. Hand off only with observed screenshots, validation results, and remaining accepted deltas.

## Drift controls

Maintain a compact working ledger:

```text
SETTLED: mode, thesis, signature, token/component system, route scope
CURRENT SLICE: one named user-visible outcome
OPEN DELTAS: maximum five, severity ordered
DO NOT TOUCH: out-of-scope routes/components
NEXT CHECK: exact render/test that proves this slice
```

Update it after each render. A changed file outside the declared slice requires a direct reason tied to the slice.

## Terra design rules

- Prefer a strong, simple direction over an ambitious direction with incomplete execution.
- In Banger mode, build one signature move well; do not add a second until the first passes mobile, reduced motion, and performance checks.
- In Docs/Refined mode, spend effort on type, measure, navigation, states, and theme parity.
- Reuse the repository's system. A new abstraction must remove duplication or encode a real design rule.
- Do not declare a visible issue fixed until the changed render has been observed.

## Reasoning/tool budget

- **Medium:** default for planning and implementation.
- **High:** structural selection, complex responsiveness, difficult reference mismatch, final hardening.
- **Max:** exceptional and explicitly justified; never the default response to ambiguity.
- Use the browser and targeted tests before increasing effort.

## Completion criterion

The selected direction is coherent, implementation stayed inside the contract and route scope, all required states/viewports/themes were observed, no P0/P1 delta remains, and final claims are backed by render and validation evidence.
