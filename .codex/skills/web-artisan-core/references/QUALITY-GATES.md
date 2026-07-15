# Quality gates

Score each dimension 0–5. Any fatal condition fails the delivery regardless of total. Target at least 34/40, with no dimension below 3.

## 1. Thesis and distinction

- 0: generic template; no product-specific direction.
- 3: coherent and appropriate, but not memorable.
- 5: unmistakably subject-specific, with a justified signature.

**Fatal:** the primary mode is visibly wrong for the product.

## 2. Hierarchy and composition

Assess focal order, grouping, density, alignment, rhythm, and container discipline.

**Fatal:** primary job/action is unclear or critical content is obscured.

## 3. Typography, color, imagery, and motion

Assess role clarity, reading quality, semantic color, asset quality, and purposeful motion.

**Fatal:** contrast or motion blocks use for a required audience.

## 4. Product UX and copy

Assess task clarity, feedback, terminology, action naming, errors, emptiness, and recovery.

**Fatal:** a core flow cannot be completed or gives misleading feedback.

## 5. Responsive and theme parity

Assess real transformation across widths and independently tuned light/dark themes.

**Fatal:** critical mobile layout/state fails; theme makes content/action illegible; a required theme is missing.

## 6. Accessibility and input

Assess semantics, labels, focus order/visibility, keyboard, target size, reduced motion, screen-reader announcements, and non-color cues.

**Fatal:** core action is inaccessible by keyboard or assistive technology where required.

## 7. State/content resilience

Assess loading, empty, error, success, disabled, selected, overflow, long content, zero/many data, permissions, and network failure.

**Fatal:** data loss, destructive ambiguity, or unhandled critical state.

## 8. Engineering and spec fidelity

Assess repository convention, reuse, maintainability, performance, dependency discipline, tests, and requested scope.

**Fatal:** production path bypasses the requested component/architecture; throwaway prototype ships; out-of-scope behavior changes; tests pass only through a proxy implementation.

## Review method

Run two independent code reviews:

- **Standards:** repository conventions, architecture, maintainability, performance, accessibility implementation.
- **Spec:** missing requirements, incorrect behavior, source-of-truth deviation, scope creep.

Then run a separate rendered-experience critique. Do not let a clean code review certify visual quality or a beautiful screenshot certify architecture.
