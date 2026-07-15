# Build and visual feedback loop

## Build in vertical slices

A slice is the smallest complete piece a user can perceive and exercise. It includes structure, content, behavior, states, responsiveness, themes, and validation.

Suggested order:

1. application shell and navigation;
2. primary page/job;
3. critical interaction;
4. secondary information;
5. edge states;
6. motion and signature refinement;
7. hardening.

Do not build all markup, then all styling, then all behavior. That delays feedback until the cost of correction is highest.

## Use real and hostile content

Include:

- longest plausible title/label;
- short and long values;
- zero, one, and many records;
- missing image/avatar;
- permission-restricted action;
- error and retry;
- loading and stale data;
- localization expansion where relevant;
- keyboard-only path.

## Visual-delta pass

For each required viewport/theme/state:

1. render the real route;
2. capture a screenshot;
3. compare to the visual source of truth and `DESIGN.md`;
4. list at most five largest deltas, in severity order;
5. fix only those deltas and any regression they create;
6. recapture;
7. mark each delta observed-closed only after seeing the changed render.

Suggested severity:

- **P0:** unusable, clipped critical content, broken navigation/state, inaccessible interaction.
- **P1:** wrong hierarchy, major reference mismatch, theme failure, layout collapse.
- **P2:** spacing, typography, crop, color, motion, or alignment visibly off.
- **P3:** micro-polish with low user impact.

Stop cycling when P0/P1 are zero and remaining P2/P3 items do not justify further complexity.

## Breakpoints

Use the product's actual breakpoints. When none exist, inspect at least:

- 1440×1000;
- 1024×768;
- 390×844;
- 360×800 when mobile density is critical.

Do not infer mobile quality from a resized desktop screenshot. Exercise menus, drawers, tables, code blocks, dialogs, and touch targets.

## Verification without proxy capture

A screenshot or test is a development aid, not the deliverable. Verify that:

- production routes import the intended components;
- state and behavior live in the requested reusable layer;
- tests drive the consumer path;
- no throwaway demo bypasses production abstractions;
- the final build contains no prototype switcher or dead variant.
