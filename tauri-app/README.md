# Ultradyn Docs desktop shell

This directory packages the browser interface as a Tauri v2 desktop app. It does not contain a second backend or expose a privileged web API.

## Repository selection

The shell will not guess a working directory. On first launch, select an existing installer-created repository in one of these ways:

```sh
ULTRADYN_DOCS_REPOSITORY=/absolute/path/to/network-docs ultradyn-docs-desktop
ultradyn-docs-desktop --repository /absolute/path/to/network-docs
```

`--repository=/absolute/path` is also accepted, and the CLI flag takes precedence over the environment variable. The path must exist, be a directory, use a UTF-8 representation, and contain `.ultradyn/manifest.json`. A validated canonical path is persisted as `repository-path.txt` in Tauri's app-config directory and reused on later launches. Supplying another explicit path validates and replaces the saved selection.

Launching for the first time without either explicit source fails closed and reports how to select a repository. There is no native folder-picker UI yet.

Only one Ultradyn desktop/browser server may own port `49321`. A second desktop launch fails rather than reusing a child owned by another process. On consoleless packaged launches (notably Windows), first-run/occupied-port errors still need a native dialog before desktop onboarding can be considered complete.

## Backend startup and readiness

For desktop version `0.1.0`, release builds launch this equivalent fixed argument vector rather than constructing a shell command string:

```sh
npx --yes --ignore-scripts --registry=https://registry.npmjs.org/ --package @ultradyn/docs@0.1.0 ultradyn-docs serve /absolute/path/to/network-docs --no-open --host 127.0.0.1 --port 49321
```

The package version is compiled from the desktop crate version rather than using npm `latest`, and the repository is passed as one argument. The child runs from Tauri's trusted app-config directory with dedicated user/global npm configuration that pins the official registry and disables lifecycle scripts; a repository-controlled `.npmrc` is therefore not consulted. The package executable itself is still trusted release code. Debug builds may use `ULTRADYN_DOCS_LOCAL_PACKAGE=/absolute/path/to/checkout` to replace only the package spec, which permits testing unpublished source without weakening release behavior.

The readiness probe requires:

- HTTP 200 from `/api/health` with `status: "ok"` and the same application version; and
- HTTP 200 from `/api/runtime` with the selected canonical `repoRoot`; and
- HTTP 200 from `/api/desktop-readiness` only when presented with the cryptographically random nonce passed to this child.

Every occupied port is rejected. A matching health/runtime response produces a specific “already running” error; an unrelated application, version, or repository produces a mismatch error. The launch nonce prevents two racing desktop processes from mistaking one another's server for their own. A newly spawned server must pass all probes within 60 seconds. The shell then uses that nonce once in a loopback bootstrap navigation; the server establishes the HttpOnly browser session and redirects to the clean root URL. The owned child process group/tree is terminated when the desktop window is destroyed or launcher state is dropped; Unix cleanup polls the whole process group and escalates from `SIGTERM` to `SIGKILL` at its deadline. The shell never takes ownership of a pre-existing server.

This is a source-level desktop wrapper, not yet a self-contained distribution: the target machine still needs Node/npm, the GUI process must inherit a usable Node/npm `PATH`, and `npx` must be able to resolve the pinned package. Bundling a backend sidecar/runtime, committing a Rust lockfile, native first-run/error UI, multi-instance UX, and platform lifecycle checks are tracked in `BLOCKED_TASKS.md`. Desktop icons are generated from `app-icon.svg` through Tauri's icon pipeline.

## Development and release verification

Install the [Tauri v2 platform prerequisites](https://v2.tauri.app/start/prerequisites/) and stable Rust. From the repository root:

```sh
pnpm build
ULTRADYN_DOCS_REPOSITORY=/absolute/path/to/network-docs \
ULTRADYN_DOCS_LOCAL_PACKAGE="$PWD" \
pnpm tauri:dev
cd tauri-app/src-tauri && cargo test
cd ../../ && pnpm tauri:build
```

The local-package override is accepted only by debug builds. Omit it when verifying the pinned published-package path or any release build.

Release builds must be exercised on Linux, macOS, and native Windows. WSL is supported for the browser/server workflow but cannot validate a native Windows WebView microphone flow. Verify repository selection/persistence, health/runtime mismatch rejection, child cleanup, microphone behavior, loopback CSP/CORS, filesystem/codec behavior, and clean-machine install/update/uninstall.

Rust/Tauri compilation, platform permissions, signing/notarization, and clean-machine tests remain activation gates in `BLOCKED_TASKS.md`. The launcher accepts no web-supplied command or argument. On Windows, `npx.cmd` still follows the platform's command-script launch behavior; the planned bundled sidecar removes that dependency.
