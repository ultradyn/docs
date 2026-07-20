# Web visual QA

## Sources of truth

- `PRODUCT.md`
- `DESIGN.md`
- Production route: `/#/settings`
- Production sources: `src/pages/SettingsPage.tsx` and `src/styles.css`

## Capture matrix

Capture paths below are transient local review evidence, not committed product
assets. Re-run the focused validators with:

```sh
pnpm vitest run code/server/security.test.ts code/web/src/api.contract.test.ts code/web/src/pages/routes.test.tsx
```

After `pnpm build`, the final Chromium check clicked the connection link from
`http://127.0.0.2:5888/` into the live server at `http://xsm:5885/`. Its
machine-readable receipt was:

```json
{
  "url": "http://xsm:5885/#/settings",
  "pageOrigin": "http://xsm:5885",
  "serverUrl": "http://xsm:5885",
  "apiOrigins": ["http://xsm:5885"],
  "sessionError": 0,
  "apiStatuses": [200]
}
```

A fresh cookie-free Chromium context also loaded `http://xsm:5885/#/ask`
directly on plain HTTP. Chromium omitted Fetch Metadata, the marked same-origin
bootstrap established the session, and the machine-readable result was:

```json
{
  "pageUrl": "http://xsm:5885/#/ask",
  "cookieCount": 1,
  "apiStatuses": {
    "/api/browser-session": 200,
    "/api/runtime": 200,
    "/api/goals": 200,
    "/api/settings": 200,
    "/api/events": 200
  },
  "sessionErrorVisible": false
}
```

Recreate captures with the repository's running route and the fixed-size helper
documented in the local `headless-browser-screenshots` skill; use 1440 x 1000
and 390 x 844 viewports and inspect both the connected and `session_required`
states.

| Route/state              |    Viewport | Theme | Capture                                                | P0/P1 | P2/P3                | Status |
| ------------------------ | ----------: | ----- | ------------------------------------------------------ | ----- | -------------------- | ------ |
| Settings / session error | 1440 x 1000 | light | `/tmp/ultradyn-settings-server-error-desktop.png`      | none  | none                 | PASS   |
| Settings / session error |   390 x 844 | light | `/tmp/ultradyn-settings-server-error-mobile-fixed.png` | none  | none after recapture | PASS   |
| Settings / connected     | 1440 x 1000 | light | `/tmp/ultradyn-settings-connected-desktop.png`         | none  | none                 | PASS   |
| Settings / connected     |   390 x 844 | light | `/tmp/ultradyn-settings-connected-mobile-final.png`    | none  | none                 | PASS   |
| Queue / combobox closed  | 1440 x 1000 | light | `/tmp/ultradyn-combobox-desktop-closed.png`            | none  | none                 | PASS   |
| Queue / combobox open    | 1440 x 1000 | light | `/tmp/ultradyn-combobox-desktop-open.png`              | none  | none                 | PASS   |
| Queue / combobox closed  |   390 x 844 | light | `/tmp/ultradyn-combobox-mobile-closed.png`             | none  | none                 | PASS   |
| Queue / combobox open    |   390 x 844 | light | `/tmp/ultradyn-combobox-mobile-open.png`               | none  | none                 | PASS   |

## Delta ledger

| ID    | Severity | Observable mismatch                                                                                           | Fix and recapture                                                                                                                    | Closed |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| V-001 | P2       | On 390 px error state, the alert icon shrank to a dot and competed with Retry in one row.                     | Mobile error uses a two-column grid; Retry moves below the message. Recaptured in `ultradyn-settings-server-error-mobile-fixed.png`. | yes    |
| V-002 | P1       | The shared combobox trigger initially exposed only an 18.6 px clickable height inside the queue filter shell. | The trigger now has a 2.4 rem minimum height. Chromium measured 38.39 px at both viewports after rebuilding and recapturing.         | yes    |

## Final statement

- P0 remaining: none observed
- P1 remaining: none observed
- Theme: light/dark/system via semantic tokens (`data-theme`); dark slate canvas with soft ink
- Keyboard/state path: semantic route tests plus a focused shared-combobox test
  cover opening, arrow-key movement, selection, Escape, and focus restoration
- Production route verified: yes, including a real cross-site handshake against
  the built server, a cookie-free direct `/#/ask` load at the remote HTTP
  hostname, and portal-listbox captures from the built queue route
- Combobox geometry verified: trigger height 38.39 px at both viewports; the
  open listbox had no left, right, top, or bottom viewport overflow
