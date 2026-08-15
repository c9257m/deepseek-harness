/**
 * GUI filesystem-browsing service: `ctx.fileBrowser` serves the browser-side
 * file tree and viewer primitives — one-level listings (files and
 * directories), child-directory creation, bounded text-file reads, and
 * atomic whole-file writes over the host filesystem via Node's stdlib (which
 * already carries the per-OS adaptation). Mounted on every web composition,
 * independent of how directory *picking* is served: the file browser must
 * work whether the directory-picker seam resolved to the native OS chooser
 * or the in-app browse dialog. The directory-picker-browse backend delegates
 * its capability methods to this service, so one implementation serves both
 * the picker dialog and the file browser. Policy decisions (hidden entries
 * flagged but returned, symlinks resolved, whole-filesystem scope, read byte
 * bound with binary rejection, atomic writes) are recorded in the
 * directory-picker seam Agent Note.
 * @module @deepseek-ai/dsh-host-file-browser
 */

import { mkdir, open, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry, DirectoryListing,
} from '@deepseek-ai/dsh-host-directory-picker'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The GUI filesystem-browsing service (one implementation per context). */
    fileBrowser: FileBrowser
  }
}

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    // basename of a root is '' — label the root crumb by its full path ('/', 'C:\').
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false, kind: 'directory' })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\…`) or complete UNC (`\\server\share…`) forms. Rooted drive-less
 * forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`)
 * pass `isAbsolute` yet still resolve against the process's current drive.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/** One streamed listing candidate: the dirent facts a row needs, nothing else retained. */
export interface ListingCandidate {
  /** Base name within the streamed level. */
  name: string
  /** Dirent says directory (no probe needed). */
  isDirectory: boolean
  /** Dirent says symlink (target kind needs a stat probe). */
  isSymbolicLink: boolean
}

/**
 * Insert a streamed candidate into the name-sorted bounded window, evicting
 * the name-largest candidate when the window exceeds `keep`. Memory over an
 * arbitrarily large level therefore stays O(keep) regardless of how many
 * children the directory holds.
 * @param window - the name-ascending window, mutated in place.
 * @param candidate - the streamed candidate to place.
 * @param keep - the window bound.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
export function boundedInsert(window: ListingCandidate[], candidate: ListingCandidate, keep: number): boolean {
  // Full window, name at or beyond the tail: one comparison rejects, so an
  // oversized level costs O(1) per candidate past the head instead of a
  // window scan (100k children against a 1,001 window must not approach
  // 10^8 comparisons).
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a full window (length === keep >= 1) has a tail
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1]!.name) >= 0) return true
  // Binary insertion keeps a retained candidate at O(log keep) comparisons.
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. Node's filesystem reads are not retractable, so the operation
 * itself keeps running against a handle the caller then closes — its late
 * settlement is swallowed here so an abandoned read cannot surface as an
 * unhandled rejection.
 * @param operation - the in-flight filesystem step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned read: its handle is being closed by the aborting caller,
        // and the abort reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/* v8 ignore start -- a close failure of an abandoned handle has no consumer, and forcing one needs a filesystem torn down mid-request. */
/** Swallow the close failure of a handle its caller already departed. */
function swallowCloseFailure(): void {}
/* v8 ignore stop */

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/**
 * One listing row for a dirent, resolving symlinks to their target kind;
 * null for broken/cyclic links (skipped silently — a browser shows what
 * exists, and a broken link cannot).
 */
async function entryRow(
  parent: string, name: string, isDirectory: boolean, isSymbolicLink: boolean, signal: AbortSignal | undefined,
): Promise<DirectoryEntry | null> {
  const path = join(parent, name)
  let kind: 'directory' | 'file'
  if (isDirectory) {
    kind = 'directory'
  } else if (isSymbolicLink) {
    try {
      // The probe races the caller too: a symlink target on a stalled
      // network filesystem must not keep a departed caller's request alive.
      kind = (await raceAbort(stat(path), signal)).isDirectory() ? 'directory' : 'file'
    } catch {
      /* v8 ignore next 2 -- an abort landing mid-probe needs a stalled stat; the per-candidate check in list covers the settled path. */
      if (signal?.aborted) throw asError(signal.reason)
      // Broken or cyclic symlink: stat is the probe, failure means "no row".
      return null
    }
  } else {
    // The scan only admits directory, file, and symlink candidates; a
    // non-directory, non-symlink candidate is a regular file.
    kind = 'file'
  }
  // POSIX hidden convention; Windows' hidden attribute is not exposed by
  // dirents (Known Limitations). The client owns whether hidden rows show.
  return { name, path, hidden: name.startsWith('.'), kind }
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link FileBrowser.Config}. */
  maxEntries: number
  /** Byte cap of one `readFile` result; larger files fail with `file-too-large`. */
  maxReadBytes: number
}

/**
 * The filesystem-browsing service implementation (stable per service life).
 */
export default class FileBrowser extends Service {
  /**
   * `maxEntries` bounds the complete listing level a single `list` call may
   * materialize and put on the wire: at most this many child rows (files and
   * directories, hidden rows included), with `truncated` flagging a cut level.
   * The default follows GitHub's web UI, which truncates directory listings at
   * 1,000 entries. `maxReadBytes` bounds one `readFile` result: a regular text
   * file at most this large (in bytes) is returned whole, anything larger
   * fails with `file-too-large` instead of a truncated result.
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
    maxReadBytes: z.natural().min(1).default(1024 * 1024),
  })

  /**
   * @param ctx - host context.
   * @param config - listing and read bounds.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'fileBrowser')
  }

  /**
   * List one directory level (files and directories), bounded by
   * {@link Config.maxEntries}.
   * @param path - absolute directory to list; absent lists the home directory.
   * @param signal - caller lifetime; abort stops the scan (a stalled network
   * directory must not outlive a disconnected caller) and rejects with the
   * abort reason.
   * @returns the level's listing with ancestry; a cut level reports `truncated`.
   * @throws {DirectoryPickerError} `directory-unreadable` when the target is not fully
   * qualified (a wire value must never resolve against the host cwd or, on
   * Windows, its current drive) or cannot be listed.
   */
  async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const home = homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)
    // Stream the level (opendir, one dirent at a time) into a name-sorted
    // window of maxEntries + 1 candidates: memory stays bounded no matter how
    // many children the directory holds, the window keeps the name-sorted
    // head, and the +1 slot lets an in-window extra row prove the cut. A
    // window candidate that turns out non-enterable (broken symlink) is not
    // backfilled from beyond the window — an eviction already marks the
    // level truncated, which stays the honest answer.
    const keep = this.config.maxEntries + 1
    const window: ListingCandidate[] = []
    let evicted = false
    try {
      // Every filesystem await races the caller's signal: a stalled
      // opendir/read on a network filesystem must not keep a departed
      // caller's scan alive, and an already-aborted request rejects even
      // when the level is empty.
      const opening = opendir(target)
      const level = await raceAbort(opening, signal).catch((error: unknown) => {
        // The abandoned open can still mint a handle after the abort won;
        // close it so a departed caller cannot leak a descriptor. (A lost
        // race against opendir's own rejection has nothing to close, and
        // the close's own failure is swallowed — the request already
        // returned, so a cleanup error has no consumer.)
        void opening.then(dir => dir.close().catch(swallowCloseFailure), () => {
          // Already rejected: raceAbort surfaced or swallowed it.
        })
        throw error
      })
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal)
          if (dirent === null) break
          // Directories, files, and symlinks contend for the window; a
          // symlink's target kind needs the later stat probe. Other dirent
          // kinds (sockets, FIFOs, devices) are neither enterable nor
          // readable text, so they never contend.
          if (!dirent.isDirectory() && !dirent.isFile() && !dirent.isSymbolicLink()) continue
          const candidate = {
            name: dirent.name,
            isDirectory: dirent.isDirectory(),
            isSymbolicLink: dirent.isSymbolicLink(),
          }
          if (boundedInsert(window, candidate, keep)) evicted = true
        }
      } finally {
        // Manual read() never auto-closes; close on every exit. The aborted
        // exit must not await it — Node queues close behind any in-flight
        // read, so awaiting would chain the departed caller back onto the
        // very stall the abort escaped (the abandoned read's settlement is
        // already swallowed by raceAbort).
        const closing = level.close()
        /* v8 ignore next 3 -- an abort between open and close needs a stalled read; the abandoned-close arm has no observable outcome. */
        if (signal?.aborted) {
          closing.catch(swallowCloseFailure)
        } else {
          await closing
        }
      }
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      // A caller that departed between reads and probes stops before the
      // next probe (each probe's own await is raced inside entryRow).
      signal?.throwIfAborted()
      const row = await entryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal)
      if (row === null) continue
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      entries.push(row)
    }
    return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated }
  }

  /**
   * Create one child directory under an existing parent.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment (no separators, not `.`/`..`).
   * @returns the created directory's absolute path.
   * @throws {DirectoryPickerError} `directory-exists` for an existing child,
   * `directory-create-failed` for a parent that is not fully qualified or any other failure.
   */
  async createDirectory(path: string, name: string): Promise<string> {
    // Same fully-qualified fence as list: never rebase a parent under the
    // cwd or the current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    const parent = resolve(path)
    // The backend owns segment validation (the wire schema also refuses these,
    // but direct service consumers must hit the same fence).
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = join(parent, name)
    try {
      // Non-recursive: the parent is the directory the browser is showing, so
      // a missing parent is a real failure, not a level to invent.
      await mkdir(target)
      return target
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }

  /**
   * Read a regular text file, bounded to {@link Config.maxReadBytes}.
   * @param path - absolute file to read.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns the decoded UTF-8 content of the whole file.
   * @throws {DirectoryPickerError} `file-unreadable` when the path is not
   * fully qualified or cannot be read as a regular file,
   * `file-too-large` when the file exceeds the backend's byte cap, and
   * `file-not-text` when the content is not valid text (binary rejection).
   */
  async readFile(path: string, signal?: AbortSignal): Promise<string> {
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('file-unreadable', path, `cannot read "${path}": not a fully qualified path`)
    }
    const target = resolve(path)
    let info
    try {
      info = await raceAbort(stat(target), signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new DirectoryPickerError('file-unreadable', target, `cannot stat ${target}: ${messageOf(error)}`)
    }
    if (!info.isFile()) {
      throw new DirectoryPickerError('file-unreadable', target, `cannot read ${target}: not a regular file`)
    }
    if (info.size > this.config.maxReadBytes) {
      throw new DirectoryPickerError('file-too-large', target, `${target} is ${info.size} bytes; the read bound is ${this.config.maxReadBytes}`)
    }
    // Read at most maxReadBytes + 1 bytes anyway: the file may have grown
    // between the stat and the open, and the bound must hold on the complete
    // result, never just the pre-checked size.
    const opening = open(target, 'r')
    const handle = await raceAbort(opening, signal).catch((error: unknown) => {
      // The abandoned open can still mint a handle after the abort won; close
      // it so a departed caller cannot leak a descriptor. (A lost race against
      // open's own rejection has nothing to close, and the close's own failure
      // is swallowed — the request already returned, so a cleanup error has no
      // consumer.)
      void opening.then(fh => fh.close().catch(swallowCloseFailure), () => {
        // Already rejected: raceAbort surfaced or swallowed it.
      })
      throw error
    })
    try {
      const buffer = Buffer.alloc(this.config.maxReadBytes + 1)
      const { bytesRead } = await raceAbort(handle.read(buffer, 0, buffer.length, 0), signal)
      if (bytesRead > this.config.maxReadBytes) {
        throw new DirectoryPickerError('file-too-large', target, `${target} exceeds the read bound of ${this.config.maxReadBytes} bytes`)
      }
      const content = buffer.subarray(0, bytesRead)
      // Binary rejection by NUL presence: the first bounded window of a
      // binary file virtually always carries one, and the rejection must be
      // decided on the complete result, not a decode artifact.
      if (content.indexOf(0) !== -1) {
        throw new DirectoryPickerError('file-not-text', target, `${target} is not a text file`)
      }
      return content.toString('utf8')
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw error
    } finally {
      const closing = handle.close()
      /* v8 ignore next 3 -- an abort between read and close needs a stalled read; the abandoned-close arm has no observable outcome. */
      if (signal?.aborted) {
        closing.catch(swallowCloseFailure)
      } else {
        await closing
      }
    }
  }

  /**
   * Replace a text file's whole content atomically (temp sibling + rename,
   * via the atomic-write utility), so readers observe either the old or the
   * new complete content and a failed write leaves the target untouched.
   * @param path - absolute file to write.
   * @param content - the complete next file content.
   * @throws {DirectoryPickerError} `file-write-failed` when the path is not
   * fully qualified or the replacement fails for any filesystem reason.
   */
  async writeFile(path: string, content: string): Promise<void> {
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('file-write-failed', path, `cannot write "${path}": not a fully qualified path`)
    }
    const target = resolve(path)
    try {
      await writeFileAtomic(target, content, { mode: 0o666 })
    } catch (error: unknown) {
      throw new DirectoryPickerError('file-write-failed', target, `cannot write ${target}: ${messageOf(error)}`)
    }
  }
}
