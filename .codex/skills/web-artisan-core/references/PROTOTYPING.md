# Structural prototyping

## Purpose

A prototype answers “what should this look and work like?” before production constraints make every later change expensive.

## Shape

Prefer variants embedded in the real route or shell, with real header/sidebar/data and a query parameter such as `?variant=A`. A standalone empty mock route is a last resort because it hides density and integration problems.

## Variant rules

Each variant must differ in at least three of:

- information hierarchy;
- page regions and grid;
- primary affordance;
- navigation model;
- density;
- content sequencing;
- interaction model;
- signature move.

Changing palette, font, radius, or shadows alone is not a new variant.

## Evaluation card

For each variant record:

- one-sentence concept;
- what becomes easiest for the user;
- what becomes harder;
- strongest subject-specific decision;
- accessibility/responsive risk;
- engineering cost;
- whether it supports both themes;
- what to steal if it loses.

## Selection

Choose one structural winner. A hybrid is permitted only by naming the exact elements being combined and checking that their hierarchies do not conflict.

Capture the decision in `DESIGN.md`. Rewrite the winning structure to production standards; do not ship prototype scaffolding, switchers, or dead variants.
