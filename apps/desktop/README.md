# `@deepseek-ai/dsh-desktop`

Electron desktop shell for the dsh Web UI. It starts the harness web server as a child process on Node and shows the served UI in a native window, so a packaged install needs neither a separate Node.js installation nor a terminal command: double-click the desktop shortcut and the harness opens.

The shell owns only process and window lifecycle — spawning and stopping the server, the single instance lock, and same-origin window handling. Model keys, workspaces, and plugins are configured in the Web UI itself.

## Runtime model

The server runs on real Node, never on Electron's embedded runtime: the harness loader reaches Node internals through `node-addon-require-builtin`, which fails in Electron's V8 realm (`ELECTRON_RUN_AS_NODE` reports "Unsupported/no-realm"), so an Electron-Node server cannot resolve its plugin packages. A packaged install ships the Node distribution under `resources/runtime`; a source run reuses the developer's own Node.

## Run from source

Requires a full harness build first (`pnpm run build`), which produces the CLI bundle at `apps/cli/lib/bin.js` and the frontend dist.

```sh
pnpm run build
pnpm desktop:dev
```

The shell boots the `web` profile on port `32080` (`DSH_DESKTOP_PORT` overrides it), distinct from the CLI's default `3080`. Closing the window stops the server.

## Build the installer

```sh
pnpm desktop:pack        # unpacked app directory, for faster iteration
pnpm desktop:dist        # NSIS installer under apps/desktop/dist
```

Both fetch the pinned Node runtime (`apps/desktop/scripts/fetch-node-runtime.mjs` downloads it into `apps/desktop/runtime/`) before running electron-builder. The Windows target is the supported package; the Electron version is pinned so its bundled Node satisfies the harness engine range (`^22.19 || >=24`), and the fetched Node release line matches it.

`@deepseek-ai/dsh-desktop` declares the harness's runtime peer set as direct dependencies (mirroring the `python/sdk-runtime` deployment root): the packaging collectors prune peer dependencies, and the harness mounts its Service Definition packages as peers, so the packaged closure must carry them explicitly or boot fails with `ERR_MODULE_NOT_FOUND`.

## Privacy and size

All user data — model credentials, settings, sessions, and storages — lives under `$DSH_HOME` (default `~/.dsh`), outside the installation directory. The installer bundles only the application payload (Electron, the Node runtime, and the harness closure); it never contains the packaging machine's credentials, so the same installer is safe to hand to other people. Each installation starts with a fresh, empty profile.

The payload is trimmed for size: sourcemaps are excluded (`!**/*.map`, ~50MB), Chromium ships only `en-US` and `zh-CN` locale packs (~45MB saved), and the NSIS installer uses the maximum LZMA preset. Electron itself and the bundled `node.exe` dominate the remaining footprint and are not reducible.

## Known limitations and deferred work

- **No per-host native rebuild** (`npmRebuild: false`). On Windows the web profile mounts the PowerShell stack, never node-pty, and the remaining native modules (koffi, `node-addon-require-builtin`) are N-API prebuilds, so the packaged app ships the dependencies as installed. macOS or Linux packaging would need to re-enable the node-pty rebuild.
- **No custom application icon yet**; the packaged app uses the Electron default. `build/icon.ico` is the expected drop-in location.
- **Fixed desktop port**: a conflicting process on the desktop port fails the launch with an in-window error; relaunch after freeing the port or set `DSH_DESKTOP_PORT` before starting.
