# Generated-UI failure checklist

Use this diagnostically. Replace each failure with a positive, brief-specific decision.

## Identity

- Could the design fit unrelated SaaS products without changing anything but copy?
- Is the subject's actual world absent from type, structure, imagery, or interaction?
- Did a named trend become the entire concept?

## Layout

- Is every group a card?
- Are cards nested inside cards?
- Does container chrome replace alignment and typography?
- Do all sections have equal visual weight?
- Is a product surface paced like a landing page?
- Does mobile merely stack desktop?

## Type and color

- One default sans family for every role?
- Type scale generated from generic presets without optical tuning?
- Accent color used everywhere and therefore nowhere?
- Purple/blue gradient, glow, or glass used without subject reason?
- Muted text too faint in either theme?
- Dark theme made by inversion?

## Content and states

- Placeholder copy or suspiciously uniform fake data?
- Buttons named after implementation (“Submit,” “Execute”)?
- Missing loading/empty/error/disabled/selected/focus states?
- Long content, localization, zero/many data untested?

## Motion and assets

- Same fade-up on every section?
- Bounce/elastic effects without a playful product rationale?
- Abstract blobs compensating for missing imagery?
- Icons placed in identical rounded tiles above every heading?
- Animation survives no reduced-motion or low-power path?

## Verification

- No browser render inspected?
- “Fixed” based on code change rather than observed output?
- Screenshot test passes while production component is bypassed?
- Prototype, variant switcher, or dead system remains in main?
- New token/component system duplicates an existing one?
