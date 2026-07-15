# Light and dark themes

## Default rule

Design both themes from the start. A single-theme exception must be explicit in `DESIGN.md` with one of:

- the user requested one theme;
- the experience is a fixed installation/artwork/game whose ambient medium is essential;
- brand/legal requirements prohibit a second theme;
- the platform cannot support theme switching and the user accepted that constraint.

“Dark mode is extra work” is not an exception.

## Semantic token model

Use semantic roles rather than component-specific colors:

- canvas;
- surface-1 / surface-2 / elevated;
- text-primary / text-secondary / text-muted;
- border-subtle / border-strong;
- accent / accent-contrast;
- focus;
- selection;
- success / warning / danger / info;
- code background/text/tokens;
- data series and gridlines.

Tune each theme independently. Dark mode usually needs reduced contrast between large surfaces, stronger local boundaries, lower-chroma large areas, and carefully controlled bright text.

## Theme parity review

Check in both themes:

- hierarchy is equivalent;
- primary action remains primary;
- disabled and muted states remain legible;
- focus and selection are visible;
- borders/elevation remain distinguishable;
- logos/images have suitable variants or backplates;
- charts preserve series distinction and semantic meaning;
- syntax highlighting is readable;
- native controls respect `color-scheme`;
- browser chrome/meta theme colors are appropriate;
- transitions do not flash the wrong theme;
- stored/system preference behavior is deterministic.

## Implementation notes

Prefer CSS custom properties and a root theme attribute/class. Avoid duplicating component styles for each theme. Do not animate every color on initial hydration; prevent theme flash. Respect `prefers-color-scheme` and provide an explicit user control unless the brief says otherwise.
