# Agent Note: Electron desktop shell for the dsh Web UI

Status: implemented

English | [中文](2026-08-15-desktop-electron-shell.zh.md)

## Problem

`dsh web` runs only from a terminal: the operator installs Node, runs `pnpm dsh web` or `npx @deepseek-ai/dsh web`, and opens a browser at `http://127.0.0.1:3080`. The repository's one-click `start-web.bat` still requires the pnpm/Node toolchain and a build. A desktop deliverable should start the harness and show its UI from a single desktop shortcut, with no Node installation and no terminal command.

## Decision

`apps/desktop` ships `@deepseek-ai/dsh-desktop`, an Electron shell. It starts the harness web server as a child process on a bundled Node runtime and shows the served UI in a native BrowserWindow, so the packaged app is self-contained: double-click the shortcut, and the harness opens.

The shell owns only process and window lifecycle:

- **Server runtime**: a packaged install ships the Node.js distribution under `resources/runtime` (fetched by `apps/desktop/scripts/fetch-node-runtime.mjs`, pinned to Node `24.18.1`, inside the harness engine range `^22.19 || >=24`). A source run reuses the developer's own Node. The server runs on real Node, never on Electron's embedded runtime, because the harness loader reaches Node internals through `node-addon-require-builtin`; under `ELECTRON_RUN_AS_NODE` that addon fails its V8-realm probe with `Unsupported/no-realm`, so an Electron-Node server cannot resolve its plugin packages.
- **Port**: the shell boots the `web` profile with `--port 32080` (`DSH_DESKTOP_PORT` overrides), distinct from the CLI default `3080`, then waits for the server to answer before loading the UI. A failing boot or early exit shows an in-window error page carrying the child's stderr tail.
- **Window**: a splash data URL covers startup; `show: false` plus `ready-to-show` avoids a blank flash. Same-origin windows open in-app; anything else leaves via `shell.openExternal`, and `will-navigate` keeps the shell on its own origin.
- **Lifecycle**: the single-instance lock focuses the existing window on a second launch; closing the window stops the server (`taskkill /T` on Windows so short-lived tool subprocesses do not outlive their parent).
- **Packaging**: electron-builder NSIS target, `asar: false` (the app already ships the full node_modules closure), `npmRebuild: false` — on Windows the web profile mounts the PowerShell stack, never node-pty, and the remaining native modules (koffi, `node-addon-require-builtin`) are N-API prebuilds, so no Electron-ABI rebuild and no compiler toolchain are required.
- **Dependency closure**: `@deepseek-ai/dsh-desktop` declares the harness's runtime peer set as direct dependencies, mirroring the `python/sdk-runtime` deployment root. `pnpm deploy` and electron-builder's node-module collector both prune peer dependencies; the harness mounts Service Definition packages (cordis, `dsh-invariants`, `dsh-agent`, `dsh-llm`, the vendored `cordis-plugin-*`, and so on) as peers, so a packaged closure without them fails boot with `ERR_MODULE_NOT_FOUND` on the first peer import.
- **Payload size and privacy**: the installer trims sourcemaps (`!**/*.map`, ~50MB in the harness closure), restricts Chromium locale packs to `en-US` and `zh-CN` (~45MB saved; the Web UI localizes itself), and uses the maximum NSIS LZMA preset. All user data — credentials, settings, sessions, storages — lives under `$DSH_HOME` (default `~/.dsh`), outside the installation directory, so a built installer never carries the packaging machine's profile and is safe to distribute. Electron's own binary and the bundled `node.exe` dominate the remaining footprint.

## Alternatives considered

**Spawn the CLI with Electron's own Node (`ELECTRON_RUN_AS_NODE`).** Rejected after a live probe: `node-addon-require-builtin` loads under Electron but `requireBuiltin('internal/modules/esm/loader')` throws `Unsupported/no-realm (no compatible GetAlignedPointerFromEmbedderData symbol found)`, so `ModuleLoader.fromInternal()` returns `undefined` and the loader falls back to plain `import()` from its own module path, which cannot resolve the workspace `@deepseek-ai/dsh-*` plugins (the pnpm layout does not hoist them to the root `node_modules`).

**Enable `hoist-workspace-packages` so the plain-import fallback resolves.** Rejected: it is a repo-global install-layout change made only to work around a degraded runtime, and it leaves the harness without its internal-module hooks.

**Boot the harness in-process inside the Electron main process.** Rejected: the same V8-realm blocker applies, and the harness's own process lifecycle would share Electron's.

**Node SEA single executable plus the system browser.** Rejected: SEA cannot provide a window, so the app would still depend on an external browser, and native-module bundling into the executable is unsupported.

## Consequences

A packaged install is self-contained but large: Electron, the Node runtime, and the entire harness dependency closure ship together. Windows is the supported packaging target; macOS or Linux would need the node-pty rebuild re-enabled (`npmRebuild: false` is a Windows-web-profile assumption). The desktop port is fixed (`32080`, `DSH_DESKTOP_PORT` to override); a conflicting process fails the launch with an in-window error. The shell has no custom application icon yet; `build/icon.ico` is the expected drop-in location. The package is a release member like `apps/cli`, with a `lib` publication policy added to the workspace-constraints gate. electron-builder is pinned through a `@electron/get` 5.x workspace override: its default `^3.0.0` resolution (3.0.0) lacks the `ElectronDownloadCacheMode` export electron-builder 26.15 reads, while the electron package itself requires `^5.0.0`. The packaging pipeline is exercised up to the node-module collector; producing the installer runs `pnpm desktop:dist` from a normal terminal.
