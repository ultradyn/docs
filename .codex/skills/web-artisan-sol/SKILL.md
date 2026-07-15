---
name: web-artisan-sol
description: Quality-first studio workflow for GPT-5.6 Sol to design and build exceptional websites and web interfaces.
disable-model-invocation: true
---

# Web Artisan — GPT-5.6 Sol

Run the sibling `web-artisan-core` skill as a **studio** with Sol's deeper exploration budget.

## Sol profile

Use Sol for zero-to-one direction, difficult reference reconciliation, signature interactions, complex responsive systems, and final cross-disciplinary critique. Do not spend max reasoning on routine edits or on prompts missing a success criterion.

## Studio sequence

1. Read `../web-artisan-core/SKILL.md` and the context pointers it triggers.
2. Inspect the repository and visual sources before proposing changes.
3. Establish `PRODUCT.md` and classify the mode.
4. Produce **three structurally different directions** using realistic content and the real shell. Give each a short evaluation card.
5. Select a direction. When the user is present, present the strongest candidates compactly. When unavailable, choose the best-scoring direction and record the rationale.
6. Freeze `DESIGN.md`, `STATE-MATRIX.md`, and the light/dark token plan.
7. Build in vertical slices, rendering after every significant slice.
8. Run at least **three visual-delta passes** and at most six unless new evidence justifies another. Each pass addresses the largest observed deltas.
9. Run independent reviews for: art direction/UX, accessibility/themes, and standards/spec. Use parallel reviewers or subagents where available; keep their axes separate.
10. Finish only when the core quality gate passes and the handoff includes render evidence.

## Sol exploration rules

- One direction may be safe, one may be strong, and one may be radical; all must remain credible for the product.
- Make variants structurally different, not a mood-board carousel.
- Sol may invent one technically ambitious signature move in Banger mode, but must prototype it before committing the page around it.
- In Refined or Docs mode, spend the exploration budget on proportion, typography, navigation, content structure, and micro-interaction—not spectacle.
- Once `DESIGN.md` is frozen, do not reopen art direction during routine implementation. Log proposed changes and judge them at the next render gate.

## Reasoning/tool budget

- **Medium:** routine slices, known component work, straightforward responsive fixes.
- **High:** art direction, structural variants, difficult design-system integration, final critique.
- **Max/ultra:** only the hardest quality-first decision where high is demonstrably insufficient.
- Prefer browser evidence, tests, and concise design artifacts over repeated repository analysis.

## Completion criterion

The site is not done because the code builds. It is done when the actual rendered experience passes every required core gate, uses the requested production architecture, has first-class light/dark themes or a justified exception, and contains a subject-specific design decision worth remembering.
