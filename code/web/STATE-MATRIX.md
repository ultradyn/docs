# Settings server-connection state matrix

| State              | Observable behavior                                                                        | Evidence                                 |
| ------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Default            | Same-origin bootstrap runs before runtime; current origin appears in the Server URL field. | API contract and built-browser receipt   |
| Recovery           | Connect opens the explicit handshake for a corrected or different server origin.           | Web route test and connected screenshots |
| Focus/keyboard     | Native URL input and link follow document order and use the global focus ring.             | Semantic review                          |
| Loading            | Connection control remains available while server settings load.                           | Component structure                      |
| Error              | API error remains an alert; URL and Connect stay usable above it.                          | Exact `session_required` route test      |
| Invalid URL        | Field is `aria-invalid`; Connect is disabled and no unsafe scheme is linked.               | URL construction branch                  |
| Success            | Direct `/#/ask` and recovery navigation load protected APIs without `session_required`.    | Built-server Chromium flows              |
| Mobile             | Surface stacks copy, input, and action; error icon/message/action use a two-column grid.   | 390 x 844 capture                        |
| Long content       | Copy wraps inside `minmax(0, 1fr)` regions without covering actions.                       | Desktop/mobile error captures            |
| Offline/permission | Recovery does not depend on the failed API and does not write portable settings.           | Component and security review            |
| Theme              | Uses semantic light-theme tokens; current app has no implemented dark theme.               | `src/styles.css`                         |

## Shared combobox states

| State                | Observable behavior                                                                                             | Evidence                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Closed               | Styled trigger shows the selected label and exposes `aria-expanded=false`.                                      | Queue route behavior test                         |
| Open                 | Portal listbox uses the shared surface, border, shadow, and option geometry.                                    | Rendered Queue inspection                         |
| Active/selected      | Keyboard or pointer-active option is highlighted; the selected option carries a check and `aria-selected=true`. | Queue route behavior test and rendered inspection |
| Keyboard             | Arrow, Home, End, Enter, Space, Escape, Tab dismissal, and first-character navigation work from the trigger.    | Shared component behavior test                    |
| Constrained viewport | Menu chooses available space, caps its height, scrolls internally, and closes on viewport movement.             | Desktop/mobile rendered inspection                |
| Disabled/required    | Trigger exposes native disabled state or `aria-required`; consuming forms retain submission guards.             | Component and Agent-Smith route tests             |

## Content stress fixtures

- Long error: `Open the server URL directly to establish a local browser session.`
- URL: `https://docs-server.internal.example:8443`
- Invalid schemes: `javascript:`, `file:`, and malformed text
- Narrow viewport: 390 x 844
- Irreversible action: none; Connect is navigation only
