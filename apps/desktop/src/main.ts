/**
 * Electron main process for the DeepSeek Harness desktop shell.
 *
 * The shell starts the dsh web server as a child process on a bundled Node
 * runtime, waits for the configured port to answer, and shows the served UI
 * in a native BrowserWindow. Closing the window stops the child server; the
 * single-instance lock focuses the existing window on a second launch.
 *
 * The server runs on real Node, not Electron's embedded runtime: the harness
 * loader reaches Node internals through `node-addon-require-builtin`, whose
 * V8-realm probe fails under Electron (`ELECTRON_RUN_AS_NODE` reports
 * "Unsupported/no-realm"), so an Electron-Node server cannot resolve its
 * plugin packages. A packaged install ships the Node distribution under
 * `resources/runtime`; a source run reuses the developer's own Node.
 *
 * The shell owns only process and window lifecycle. It never configures the
 * harness: model keys, workspaces, and plugins are the Web UI's own settings.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'

/** Port the desktop shell serves the harness on; distinct from the CLI default 3080. */
const DEFAULT_PORT = 32080

/** Milliseconds to wait for the server before failing the launch. */
const SERVER_STARTUP_TIMEOUT_MS = 60_000

/** Milliseconds between server readiness probes. */
const PROBE_INTERVAL_MS = 500

/** Environment variable that overrides {@link DEFAULT_PORT}. */
const PORT_ENV = 'DSH_DESKTOP_PORT'

/** The single app window; `undefined` after it closes. */
let mainWindow: BrowserWindow | undefined

/** The harness server child owned by the running shell. */
let activeServer: HarnessServer | undefined

/**
 * Absolute path of the dsh CLI entry this shell boots.
 * @returns the built bin path.
 * @throws when the harness has not been built (source run only).
 */
function resolveCliBin(): string {
  if (app.isPackaged) {
    // electron-builder places the app payload (node_modules included) under
    // resources/app when asar is disabled.
    return join(process.resourcesPath, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }
  // Source layout: apps/desktop/lib/main.js -> apps/cli/lib/bin.js. The bin
  // exists only after `pnpm run build:lib:host`.
  return fileURLToPath(new URL('../../cli/lib/bin.js', import.meta.url))
}

/**
 * Absolute path of the Node binary that runs the harness server.
 * @returns the bundled runtime in a packaged install (`resources/runtime`),
 * or the developer's own Node in a source run.
 */
function resolveNodeBin(): string {
  if (app.isPackaged) {
    const name = process.platform === 'win32' ? 'node.exe' : join('bin', 'node')
    return join(process.resourcesPath, 'runtime', name)
  }
  return process.env.npm_node_execpath ?? 'node'
}

/**
 * Working directory of the harness server child.
 *
 * The harness treats the calling directory as its default filesystem location
 * and the Web UI adds workspaces explicitly, so the packaged shell points the
 * server at the user home (a writable, neutral default) instead of the
 * installation directory under Program Files.
 * @returns the child's working directory.
 */
function resolveServerCwd(): string {
  if (app.isPackaged) return homedir()
  return fileURLToPath(new URL('../../..', import.meta.url))
}

/**
 * Resolve the launch port from the environment.
 * @returns a valid TCP port, or {@link DEFAULT_PORT} when `DSH_DESKTOP_PORT` is unset.
 * @throws when the variable names a non-numeric or out-of-range port.
 */
function resolvePort(): number {
  const raw = process.env[PORT_ENV]
  if (raw === undefined) return DEFAULT_PORT
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) return parsed
  throw new Error(`${PORT_ENV} must be a valid TCP port, got ${JSON.stringify(raw)}`)
}

/**
 * Probe the server once.
 * @param port - the port to probe.
 * @returns whether the port answered and the probe error, when any.
 */
function probeOnce(port: number): Promise<{ ok: boolean; error?: Error }> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/', agent: false, timeout: 1_000 },
      (response) => {
        response.resume()
        // Any server-owned status below 5xx proves the harness is listening;
        // a transient page error is not a boot failure.
        resolve({ ok: response.statusCode !== undefined && response.statusCode < 500 })
      },
    )
    request.on('timeout', () => { request.destroy() })
    request.on('error', (error: Error) => { resolve({ ok: false, error }) })
  })
}

/**
 * Wait until the server answers, the poll observes a terminal failure, or the
 * budget elapses.
 * @param port - the port to probe.
 * @param timeoutMs - the overall budget.
 * @param failure - optional sync predicate naming a terminal child failure.
 * @throws with the failure or timeout reason.
 */
async function waitForServer(port: number, timeoutMs: number, failure: () => string | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    const why = failure()
    if (why !== undefined) throw new Error(why)
    const probe = await probeOnce(port)
    if (probe.ok) return
    lastError = probe.error
    await new Promise(resolve => setTimeout(resolve, PROBE_INTERVAL_MS))
  }
  const detail = lastError === undefined ? '' : ` (${lastError.message})`
  throw new Error(`the server did not answer on port ${port} within ${timeoutMs}ms${detail}`)
}

/**
 * Owns the harness server child: spawn, readiness wait, and termination.
 */
class HarnessServer {
  readonly #port: number
  #child: ChildProcess | undefined
  #logTail = ''

  /** @param port - the port the harness should bind. */
  constructor(port: number) {
    this.#port = port
  }

  /** The port the harness was asked to bind. */
  get port(): number {
    return this.#port
  }

  /** The child's recent stderr, for failure diagnostics. */
  get logTail(): string {
    return this.#logTail
  }

  /**
   * Spawn the harness CLI and wait until its server answers.
   * @throws when the spawn or the readiness wait fails; the child is then
   * stopped before the error propagates.
   */
  async start(): Promise<void> {
    const bin = resolveCliBin()
    const child = spawn(resolveNodeBin(), [bin, 'web', '--port', String(this.#port)], {
      cwd: resolveServerCwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child
    child.stderr.on('data', (chunk: Buffer) => {
      this.#logTail = (this.#logTail + chunk.toString('utf8')).slice(-4_000)
    })
    try {
      await waitForServer(this.#port, SERVER_STARTUP_TIMEOUT_MS, () => this.#failureReason())
    } catch (error) {
      this.stop()
      throw error
    }
  }

  /** Stop the child process. Safe to call when already stopped. */
  stop(): void {
    const child = this.#child
    this.#child = undefined
    if (child === undefined || child.pid === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      // Terminate the process tree: the harness can spawn short-lived tool
      // subprocesses that would otherwise outlive their parent's kill. Node
      // on Windows offers no graceful signal, so this matches child.kill().
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } else {
      child.kill()
    }
  }

  /** Why the child is no longer the server to wait on, or `undefined` when it still runs. */
  #failureReason(): string | undefined {
    const child = this.#child
    if (child === undefined || child.exitCode === null && child.signalCode === null) return undefined
    return `the harness server exited early (code ${child.exitCode ?? child.signalCode ?? 'unknown'})`
  }
}

/** Render an inline page as a data URL, so the shell needs no bundled assets. */
function pageUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** The splash page shown while the harness boots. */
function splashPage(): string {
  return pageUrl(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;display:grid;place-items:center;background:#0f1115;color:#e6e6e6;
    font:16px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
    p{opacity:.85}
  </style></head><body><p>正在启动 DeepSeek Harness…</p></body></html>`)
}

/** Escape text for safe inline display inside the error page. */
function escapeHtml(text: string): string {
  return text.replace(/[<>&]/g, character => character === '<' ? '&lt;' : character === '>' ? '&gt;' : '&amp;')
}

/** The error page shown when the harness cannot boot or dies. */
function errorPage(message: string): string {
  const detail = escapeHtml(message)
  return pageUrl(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;display:grid;place-items:center;background:#0f1115;color:#e6e6e6;
    font:16px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;padding:32px}
    main{max-width:640px} h1{font-size:20px;margin:0 0 8px} pre{white-space:pre-wrap;color:#9aa;font-size:13px}
  </style></head><body><main><h1>DeepSeek Harness 启动失败</h1><pre>${detail}</pre></main></body></html>`)
}

/** Create the main window: splash first, then the harness UI once the server answers. */
async function createWindow(server: HarnessServer): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'DeepSeek Harness',
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = win

  // Same-origin pages open in-app; anything else leaves the shell for the
  // system browser. The window itself never exposes Node to the page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${server.port}/`)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Keep the harness page from navigating the shell off its own origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${server.port}/`)) event.preventDefault()
  })

  win.once('ready-to-show', () => { win.show() })
  win.on('closed', () => {
    mainWindow = undefined
    server.stop()
  })

  await win.loadURL(splashPage())
  try {
    await server.start()
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n\n${server.logTail.trim()}` : String(error)
    await win.loadURL(errorPage(message))
    return
  }
  await win.loadURL(`http://127.0.0.1:${server.port}/`)
}

/** Boot the shell: window plus harness server. */
async function run(): Promise<void> {
  app.setAppUserModelId('com.deepseekai.dsh')
  const server = new HarnessServer(resolvePort())
  activeServer = server
  await createWindow(server)
}

// Single-instance: a second launch focuses the existing window instead of
// starting a second server on the same port.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = mainWindow
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', () => { activeServer?.stop() })

  void app.whenReady().then(run).catch((error: unknown) => {
    activeServer?.stop()
    console.error('DeepSeek Harness desktop shell failed to start:', error)
    app.exit(1)
  })
}
