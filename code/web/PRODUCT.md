# Web product truth

## Subject

Ultradyn Docs is a local-first documentation workbench. Its browser surface
connects askers, answerers, and maintainers to one repository-backed server and
exposes questions, answer capture, review work, project settings, personal
settings, and provider contracts.

## Audience and job

Trusted team members use the app on desktop and mobile browsers. The Settings
route must keep repository behavior, machine-local preferences, provider
consent, and the active server connection understandable and recoverable.

The browser restores its same-origin session automatically on initial load and
after a server restart. The server-connection control is the explicit override:
when a person needs a different HTTP(S) server origin, they can enter it and
open that origin directly so its HttpOnly local session is established.

## Real content and states

- Server origins range from loopback URLs such as `http://127.0.0.1:5885` to
  deployment-reviewed HTTPS origins.
- Settings may be loading, available, unavailable, invalid, dirty, saving, or
  restart-pending.
- The connection control must remain available when settings, schema, and
  provider requests fail.
- Long API errors and narrow mobile layouts must not hide the URL or action.

## Constraints

- Ordinary foreign origins must not gain API access.
- Browser sessions use an HttpOnly `SameSite=Strict` cookie.
- Only `http:` and `https:` server URLs are actionable.
- Server settings are repository or personal values; the active browser server
  is represented by its origin and is not written into the repository.
- Use the existing React, CSS-token, Lucide, and accessible-control system.
- Theme preference (`appearance.theme`) maps to document `data-theme` and
  semantic CSS variables for light and dark interfaces.

## Success conditions

- The web client uses the origin that loaded the UI as its default API server;
  explicit development configuration and the desktop launcher may override it.
- A same-origin browser load establishes its private session before the first
  protected API request, including on plain-HTTP hostnames where Fetch Metadata
  is unavailable.
- A protected request rejected with `session_required` performs one
  deduplicated bootstrap and one replay. The SSE connection uses the same
  bootstrap while reconnecting after a dropped or restarted server.
- Ambiguous transport failures do not replay writes. Settings remain visibly
  dirty with their draft values intact so the person can save again safely.
- The exact `session_required` failure still shows an editable Server URL.
- Connect to different server remains an explicit override handshake, then lands on
  `/#/settings` with authenticated settings requests.
- Ordinary cross-site navigation still does not mint a session.
- Desktop and 390 px mobile layouts keep the control and failure recovery
  readable and keyboard-accessible.

## Vocabulary

- **Server URL**: the HTTP(S) origin hosting Ultradyn Docs.
- **Server connection**: the browser-to-server relationship.
- **Browser session**: the private HttpOnly cookie created by a marked
  same-origin bootstrap or an explicit recovery navigation; it is not human
  authentication.
