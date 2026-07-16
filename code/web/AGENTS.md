# Web UI implementation rules

These instructions apply to the complete browser UI under `code/web/`.

## Dropdown-selectable controls

- Always use `ComboBox` from `src/components/ui.tsx` for a select-only dropdown,
  filter, setting choice, or form choice.
- Do not add a native `<select>` or a page-local dropdown/listbox. ESLint rejects
  native select elements in this UI.
- Extend the shared `ComboBox` when a new option state or presentation is
  required. Keep labeling, keyboard interaction, focus, portal positioning,
  selected state, disabled/required semantics, and styling inside the shared
  component.
- Test behavior through the public Web route/component seam. Exercise pointer
  and keyboard selection, then inspect the rendered open and closed states at
  desktop and mobile widths.
