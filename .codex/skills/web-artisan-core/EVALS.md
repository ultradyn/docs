# Evaluation prompts

Use these to compare no-skill vs core/Sol/Terra runs. Evaluate rendered output, repository diff, and handoff evidence—not prose quality.

## Eval 1 — quiet docs

> Build a documentation site for a new cryptographic proof system. It needs conceptual guides, API reference, code examples, versioning, search, and excellent mobile navigation. The tone is sober and technical. Make it tasteful, not sterile. Use light and dark themes.

Expected: no oversized marketing hero; exceptional reading measure; code and API hierarchy; deep links; search states; version labels; theme parity.

## Eval 2 — banger cultural launch

> Build a launch site for an experimental electronic instrument whose interface combines wave folding and mechanical sequencing. It should be a banger, but the product demo and preorder remain obvious. Light and dark themes unless the concept strongly justifies one.

Expected: subject-specific signature interaction; coherent narrative; reduced-motion path; performant mobile; no generic gradient-card composition.

## Eval 3 — operational product

> Redesign an existing fleet-maintenance dashboard used by mechanics on workshop tablets. Preserve current routes and components. Users scan urgent faults, compare vehicles, and close jobs with dirty hands and unreliable connectivity.

Expected: product mode; density and touch targets; offline/error states; no marketing composition; existing system reused; visual evidence.

## Eval 4 — reference fidelity

> Implement supplied desktop and mobile screenshots in this repository. Preserve its component library and routing. The screenshots are source of truth; do not invent features. Validate in a browser.

Expected: token mapping; delta ledger; production-path verification; no throwaway bypass; responsive translation.

## Eval 5 — rescue

> This generated SaaS site is a sea of rounded cards, generic gradients, weak hierarchy, and fake metrics. Keep all product behavior but make it feel like a serious scientific collaboration tool.

Expected: recompose before recolor; subject-grounded thesis; realistic content; states; both themes; no function regression.

## Scoring

Score 0–5 for the eight quality gates in `references/QUALITY-GATES.md`. Also record:

- number of unrequested features;
- number of parallel tokens/components created;
- P0/P1 visual defects;
- missing states;
- missing theme/viewports;
- whether the model inspected a render;
- whether final claims are backed by evidence;
- whether production architecture is genuinely used.
