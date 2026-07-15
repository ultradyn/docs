---
name: web-artisan-rescue
description: Diagnose and rebuild a generic, inconsistent, or AI-looking existing frontend while preserving product behavior and repository architecture.
disable-model-invocation: true
---

# Web Artisan Rescue

Rescue is **design surgery**: preserve the living product, remove generic visual assumptions, and rebuild hierarchy around a specific thesis.

Read the sibling `web-artisan-core/SKILL.md`, especially `references/FAILURE-CHECKLIST.md` and the selected mode.

## Process

### 1. Baseline the product

Capture current routes, flows, states, themes, screenshots, tests, tokens, and components. Identify behavior that must not change.

**Completion:** a regression checklist and baseline captures exist.

### 2. Diagnose, do not merely dislike

Group findings under:

- identity/thesis;
- hierarchy/composition;
- typography/content;
- semantic color/themes;
- geometry/container policy;
- imagery/icons;
- motion;
- states/accessibility;
- responsive behavior;
- code/design-system integrity.

Name the user cost of each issue. “Looks generic” is not enough.

### 3. Choose the new thesis

Create/update `PRODUCT.md` and `DESIGN.md`. Preserve good existing decisions. Choose one mode and signature move. Default to light/dark parity.

### 4. Recompose before decorating

Fix in this order:

1. information hierarchy and page regions;
2. navigation and primary affordance;
3. density and grouping;
4. typography and copy;
5. semantic color and themes;
6. geometry/surfaces;
7. imagery/icons;
8. motion and delight.

Changing gradients, radius, shadows, and fonts without fixing structure is not a rescue.

### 5. Migrate in safe slices

Preserve production behavior and tests. Reuse or evolve the existing system rather than replacing it wholesale unless the system itself is the diagnosed cause. Keep a compatibility map for renamed tokens/components.

### 6. Compare before/after

Capture the same routes, states, viewports, and themes before and after. Verify function, keyboard paths, content resilience, and performance. Run independent Standards and Spec reviews.

## Completion criterion

The new surface has a subject-specific thesis, clearer hierarchy, reduced generic chrome, complete themes/states, no behavior regression, and a smaller or more coherent design system—not merely a different fashionable skin.
