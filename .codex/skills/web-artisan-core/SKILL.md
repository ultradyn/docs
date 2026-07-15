---
name: web-artisan-core
description: Art-direct, build, inspect, and harden distinctive production web interfaces. Use when another skill or the user asks to design, redesign, implement, polish, rescue, or visually audit a website, web app, dashboard, documentation site, landing page, or frontend component.
---

# Web Artisan Core

Treat frontend work as a **studio**, not a one-shot code-generation task. The studio produces a deliberate design contract, builds through the repository's real system, and certifies the rendered experience.

## Pick the mode before designing

Read [`references/MODES.md`](references/MODES.md). Select one primary mode: **Banger**, **Refined**, **Product**, **Docs**, or **Reference**. Record it in `DESIGN.md`. The mode decides density, expressiveness, motion, typography, and the quality rubric.

## Process

### 1. Inspect the ground truth

For an existing project, inspect before proposing:

- routes and application shell;
- design tokens, themes, components, icons, type, and spacing;
- representative pages and real data shapes;
- routing, state, data-fetch, validation, and test conventions;
- screenshots, Figma, product docs, brand assets, and prior decisions;
- responsive behavior and all visible states of the target.

For greenfield work, inspect the requested stack and available assets. Do not install a parallel system by reflex.

**Completion:** list the authoritative files/assets and the constraints they impose.

### 2. Establish product truth

Create or update `PRODUCT.md` from [`templates/PRODUCT.md`](templates/PRODUCT.md). Resolve facts from the repository or supplied materials rather than asking. Ask the user only for decisions that materially change the design; when unavailable, choose a defensible direction and record the assumption.

**Completion:** the subject, audience, job, real content shape, functional scope, constraints, and success conditions are explicit.

### 3. Art-direct

Read [`references/ART-DIRECTION.md`](references/ART-DIRECTION.md). Collect properties from references and anti-references. Write:

- a one-sentence visual thesis;
- 3–5 character words;
- the information hierarchy;
- one memorable **signature move**;
- typography roles;
- semantic color strategy;
- geometry, density, imagery, and motion;
- light and dark theme intent by default.

Spend boldness in one place. Everything else supports it.

**Completion:** every major choice is traceable to the subject, audience, job, or a supplied reference—not to generic “modern UI.”

### 4. Prototype structure

Before production, compare structurally different directions. The invoking model skill sets the variant count. Variants must disagree about layout, information hierarchy, and primary affordance; color-only variants do not count. Use realistic content and existing app chrome. Read [`references/PROTOTYPING.md`](references/PROTOTYPING.md).

**Completion:** one direction wins, the reason is recorded, and losing structures are excluded from production.

### 5. Freeze the design contract

Create or update `DESIGN.md` from [`templates/DESIGN.md`](templates/DESIGN.md). Map every choice to semantic tokens and repository-native components. Create the state matrix from [`templates/STATE-MATRIX.md`](templates/STATE-MATRIX.md).

Default to first-class light and dark themes. A single theme is valid only when requested or when the design concept genuinely depends on one ambient mode; record the reason.

**Completion:** implementation can proceed without improvising a second aesthetic or guessing missing states.

### 6. Build vertical slices

Read [`references/BUILD-LOOP.md`](references/BUILD-LOOP.md). Build one complete user-visible slice at a time:

1. structure and semantics;
2. real content/data;
3. interaction and state;
4. responsive transformations;
5. both themes;
6. focused validation;
7. rendered inspection.

Use existing tokens, components, routes, state, and data patterns. Add dependencies only when the repository lacks a suitable primitive and the benefit exceeds the maintenance cost.

**Completion:** the slice works and renders across its required states, viewports, input methods, and themes.

### 7. Run the visual-delta loop

A source-code review cannot certify design. Start the app and inspect the actual render. Capture the viewports and states in [`templates/VISUAL-QA.md`](templates/VISUAL-QA.md). Compare against references and `DESIGN.md`; list the largest deltas; fix them; recapture.

Do not claim a visible issue is fixed without observing the changed render. Do not use a passing screenshot test as permission to bypass the requested production component or architecture.

**Completion:** no high-severity visual delta remains, and evidence exists for desktop, mobile, both themes, and stressed content/state.

### 8. Critique independently

Apply every gate in [`references/QUALITY-GATES.md`](references/QUALITY-GATES.md):

- art direction and hierarchy;
- product UX and copy;
- accessibility and keyboard behavior;
- state and content resilience;
- responsive and theme parity;
- performance and asset quality;
- repository standards and maintainability;
- specification fidelity and scope.

Keep **Standards** and **Spec** findings separate so one cannot mask the other.

**Completion:** each finding is fixed or explicitly accepted with a reason.

### 9. Hand off evidence

Report:

- selected mode and thesis;
- routes/components changed;
- screenshots or render locations;
- validation run and results;
- remaining assumptions or accepted deviations;
- whether light and dark themes are complete;
- any intentional single-theme exception.

Never describe the site as polished, beautiful, or complete without observable evidence.

## Context pointers

- Banger work: read [`references/BANGER.md`](references/BANGER.md).
- Quiet docs/editorial work: read [`references/DOCS.md`](references/DOCS.md).
- Theme implementation: read [`references/THEMES.md`](references/THEMES.md).
- Existing generic/AI-looking work: invoke `web-artisan-rescue`.
- Common failure diagnosis: read [`references/FAILURE-CHECKLIST.md`](references/FAILURE-CHECKLIST.md).
