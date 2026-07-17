# Web design contract

## Mode and thesis

**Product.** For trusted teams maintaining repository knowledge, the interface
feels like a calm operations workbench: compact hierarchy, explicit state,
semantic color, and durable controls keep recovery obvious without turning
Settings into a landing page.

Character: calm (low visual noise), inspectable (state and scope stay visible),
precise (literal URLs and labels), and resilient (critical controls survive
failed data).

## Sources and anti-references

Authoritative sources are `src/App.tsx`, `src/pages/SettingsPage.tsx`,
`src/components/ui.tsx`, `src/styles.css`, `docs/engineering/tdd-seams.md`, and
the HTTP boundary in `../server/app.ts`.

Preserve the existing sidebar, page header, token palette, bordered surfaces,
Lucide icons, and compact settings rows. Avoid a modal-only recovery flow,
equal-weight card proliferation, hidden URL state, or a cross-origin fetch that
cannot establish the server cookie.

## Information hierarchy

1. Page identity and saved state.
2. Automatic recovery status, then the always-available different-server override.
3. Preferences/Connections tabs.
4. Loading, error, or loaded settings content.

The existing three-part Repository / Personal / Secrets scope guide is the
signature move: it turns the product's storage boundary into a scannable visual
legend. Server connection precedes it because the guide cannot load usefully
without a working server.

## Layout, type, color, and material

The connection surface uses the Settings page's `76rem` maximum width, one
existing surface, the established radius/shadow scale, body/display roles, and
semantic error treatment. Desktop uses copy / URL / action columns. Below the
existing mobile breakpoint it becomes one column with full-width input/action.

Focus uses the global high-contrast outline. Error red is reserved for the
failed resource; the connection surface remains neutral so it reads as a
recovery tool rather than another failure.

The current repository has a light-only visual implementation. Dark-theme work
is intentionally not invented in this bug fix; all additions use semantic
tokens so a future theme can map them without component rewrites.

## Components, behavior, and motion

Reuse `PageHeader`, `ErrorState`, tabs, `.button`, and existing tokens. The URL
input accepts only valid HTTP(S) targets. The action is a normal link so it is
keyboard-native and visibly exposes its destination. No new motion is added.

### Dropdown-selectable controls

`ComboBox` from `src/components/ui.tsx` is the sole select-only dropdown
primitive. Every filter, setting selector, and form choice uses its styled
trigger and portal listbox; native `<select>` elements and one-off dropdown
implementations are not permitted. Extend `ComboBox` when a new state is
needed so focus, keyboard behavior, option styling, positioning, and responsive
behavior remain consistent across the application.

The browser client defaults to `window.location.origin`, so the API hostname,
scheme, and port follow the page that served the UI. An explicit
`VITE_ULTRADYN_API_BASE` or constructor `baseUrl` remains available for
development, while Tauri keeps its launcher-owned loopback endpoint.

Before loading runtime state, a same-origin client sends a marked POST to
`/api/browser-session`. The server requires the POST's `Origin` to exactly
match its allowed Host and requires a non-form custom header before setting the
HttpOnly `SameSite=Strict` cookie. This works on plain-HTTP remote hostnames,
where Chromium omits Fetch Metadata, without letting ordinary cross-site
navigation mint a session.

Protected requests that receive `session_required` perform one deduplicated
same-origin bootstrap and one replay. A failed SSE connection repeatedly tries
the same bootstrap before opening a replacement stream. Transport failures are
not enough to replay a write because the browser cannot know whether it reached
the handler; Settings keeps its draft values and dirty state for a deliberate
retry instead.

The explicit `ultradyn_connect=1` query remains a transient override handshake
for changing server origins. The server requires document-navigation headers,
sets the same cookie, and redirects to the clean `/#/settings` route. It
recognizes either Fetch Metadata or the HTML `Upgrade-Insecure-Requests`
fallback. When Fetch Metadata is present it is authoritative, so an iframe
cannot use the compatibility fallback.

## States and accessibility

See `STATE-MATRIX.md`. Labels are programmatic, invalid URL state uses
`aria-invalid`, actions remain in document order, error content uses the shared
alert semantics, and the mobile error action wraps below the message without
shrinking its icon.

## Quality bar and non-goals

Required evidence: behavior tests at Web routes and HTTP/SSE API seams, a real
cross-site Chromium click through the built server, and rendered inspection at
1440 x 1000 and 390 x 844. Non-goals are storing a server URL in Git, weakening
ordinary cross-site navigation, adding remote authentication, or introducing a
new theme/design system.
