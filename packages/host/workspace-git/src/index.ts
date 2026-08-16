/**
 * GUI git-operations service: `ctx.workspaceGit` runs git commands in a
 * workspace directory for the browser's quick-action panel — status,
 * stage-all-and-commit, push, pull, branch listing, and branch checkout —
 * spawning the SYSTEM git binary through the `ctx.subprocess` seam with the
 * same fixed invocation and credential-prompt pin the model-facing git tool
 * uses, and reusing that package's pure parsers (`parseStatus`, `parseLog`,
 * `parseBranches`) and error vocabulary (`GitError`). The browser never
 * receives raw porcelain or a shell: every method returns the parsed wire
 * value or a typed `GitError` the API gateway maps onto a stable error code.
 *
 * Policy decisions mirror the git tool: unconfined spawn (deployment policy
 * belongs to the tool/permission seams, not this service), `GIT_TERMINAL_PROMPT=0`
 * so a credential prompt fails fast instead of hanging a caller, complete-stdout
 * acquisition for parsed commands (a lossy read fails `GIT_OUTPUT_OVERFLOW`),
 * and an owned per-op deadline so a stalled network operation cannot pin a
 * caller.
 *
 * @module @deepseek-ai/dsh-host-workspace-git
 */

import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { GitError, LOG_FORMAT, parseBranches, parseLog, parseStatus } from '@deepseek-ai/dsh-tool-git'
import type { BranchInfo, StatusInfo, StatusFile } from '@deepseek-ai/dsh-tool-git'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The GUI git-operations service (one implementation per context). */
    workspaceGit: WorkspaceGit
  }
}

/** One working-tree change with its one-letter porcelain status. */
export interface GitFileStatus extends StatusFile {}

/** The parsed working-tree picture one `status` call returns. */
export interface GitStatusValue extends StatusInfo {
  /** True when staged/unstaged/untracked/conflicted are all empty. */
  clean: boolean
}

/** The new commit identity one `commit` call returns. */
export interface GitCommitValue {
  /** Full 40-hex commit hash. */
  hash: string
  /** Short (7+) hash. */
  shortHash: string
  /** The commit subject (first line of the message). */
  subject: string
}

/** One parsed branch (the tool's `BranchInfo` shape). */
export interface GitBranchValue extends BranchInfo {}

/** The retained git output of a push/pull. */
export interface GitOutputValue {
  /** Combined stdout and stderr text (git reports progress on either stream). */
  output: string
}

/** Validated plugin configuration. */
export interface Config {
  /** Cap on the COMPLETE stdout one command will parse; a larger stream fails with `GIT_OUTPUT_OVERFLOW`. */
  outputMaxBytes: number
  /** Cooperative per-operation deadline (ms); expiry escalates to the seam's process-tree termination. */
  timeoutMs: number
  /** Terminate-escalation grace (ms) handed to the subprocess seam, bounded by `MAX_TIMER_DELAY_MS`. */
  graceMs: number
}

/** Default cap on the complete stdout one command will parse. */
export const DEFAULT_OUTPUT_MAX_BYTES = 256 * 1024

/** Default per-operation deadline (ms): network operations need room. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Default terminate-escalation grace period (ms). */
export const DEFAULT_GRACE_MS = 3_000

/**
 * The fixed git invocation every command prepends (deterministic plain text,
 * readable non-ASCII paths), headed by the resolved executable path.
 * @param git - the resolved absolute git executable path.
 * @param tail - the subcommand tail.
 * @returns the complete argv for the subprocess seam.
 */
function gitArgv(git: string, tail: readonly string[]): string[] {
  return [git, '-c', 'color.ui=false', '-c', 'core.quotepath=false', '--no-pager', ...tail]
}

/**
 * True when the path names one fixed filesystem location regardless of process
 * state (mirrors the file-browser fence).
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path)
    : path.startsWith('/')
}

/** The retained stderr tail as a diagnostic excerpt. */
function stderrExcerpt(text: string, truncated: boolean): string {
  const trimmed = text.trim()
  /* v8 ignore next -- a truncated tail needs a >64KB stderr, which the seam's cap only produces in adversarial fixtures. */
  return trimmed.length === 0 ? '' : truncated ? `${trimmed} [stderr truncated]` : trimmed
}

/** Classify one non-zero git exit; git reports merge-conflict listings on stdout and errors on stderr. */
function classifyFailure(exitCode: number, stderr: string, stderrTruncated: boolean, stdout: string): GitError {
  /* v8 ignore next 2 -- every service command reports failures on stderr; the stdout fallback mirrors the tool for merge listings. */
  const excerpt = stderrExcerpt(stderr.trim().length > 0 ? stderr : stdout, stderrTruncated)
  /* v8 ignore next -- a failure with both streams empty has no diagnostic; the arm keeps the codec total. */
  const detail = excerpt.length === 0 ? '' : `: ${excerpt}`
  if (/not a git repository/i.test(stderr)) {
    return new GitError(`not a git repository (git exited ${exitCode})${detail}`, 'GIT_NOT_A_REPOSITORY')
  }
  return new GitError(`git command failed (exit ${exitCode})${detail}`, 'GIT_FAILED')
}

/**
 * The complete retained stdout of a parsed run, or a loud overflow failure: a
 * lossy read means the seam dropped the stream head, so the service fails
 * rather than return a silently-partial working-tree picture.
 */
function requireCompleteStdout(read: SubprocessOutputRead, cap: number): string {
  if (read.lossy) {
    throw new GitError(`git produced more output than the ${cap}-byte cap retains; the workspace is too large to summarize`, 'GIT_OUTPUT_OVERFLOW')
  }
  return read.text
}

/** One completed git run: complete stdout plus the stderr excerpt. */
interface GitRunResult {
  stdout: string
  stderr: string
}

/**
 * The GUI git-operations service implementation (stable per service life).
 * Every method runs the system git binary in `path` and fails with a typed
 * {@link GitError} (`GIT_NOT_A_REPOSITORY` for a non-repo directory,
 * `GIT_ABORTED` for the deadline or caller signal, `GIT_LAUNCH_FAILED` for a
 * failed spawn, `GIT_OUTPUT_OVERFLOW` for a stdout cap breach, `GIT_FAILED`
 * for any other non-zero exit).
 */
export default class WorkspaceGit extends Service {
  /** The service drives git through the subprocess seam; declare it so loader-booted fibers may access `ctx.subprocess`. */
  static inject = ['subprocess']

  /**
   * `outputMaxBytes` bounds the COMPLETE stdout one command parses: a larger
   * stream fails `GIT_OUTPUT_OVERFLOW` instead of returning a truncated
   * working-tree picture. `timeoutMs` bounds each operation (status runs are
   * fast; push/pull can stall on a network), and `graceMs` is the seam's
   * terminate-escalation grace.
   */
  static Config: z<Config> = z.object({
    outputMaxBytes: z.natural().min(1).default(DEFAULT_OUTPUT_MAX_BYTES),
    timeoutMs: z.natural().min(1).default(DEFAULT_TIMEOUT_MS),
    graceMs: z.natural().min(1).default(DEFAULT_GRACE_MS),
  })

  /** The resolved git executable path; resolved once and cached for the service life. */
  private gitExecutable: Promise<string> | undefined

  /**
   * @param ctx - host context.
   * @param config - output, deadline, and grace bounds.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'workspaceGit')
    if (config.graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`workspace-git: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }

  /**
   * Resolve the git executable through the subprocess seam's PATH-aware
   * lookup, caching the absolute path. A bare spawn would hand PATH lookup to
   * the child environment; resolving here surfaces a precise "git not found"
   * failure with the seam's own message instead of a generic launch error.
   * @returns the absolute git executable path.
   * @throws {GitError} `GIT_LAUNCH_FAILED` when git is not resolvable.
   */
  private async resolveGit(): Promise<string> {
    this.gitExecutable ??= this.ctx.subprocess.resolveExecutable('git')
    try {
      return await this.gitExecutable
    } catch (error: unknown) {
      throw new GitError(
        'git could not be found: install git and ensure it is available on the PATH of the host process',
        'GIT_LAUNCH_FAILED',
        { cause: error },
      )
    }
  }

  /**
   * Run one git command to completion in `cwd`, returning complete stdout and
   * the stderr excerpt. The caller signal and the owned deadline fuse into one
   * abort signal handed to the subprocess seam (its terminate escalation is
   * the hard kill); non-zero exits classify into the {@link GitError}
   * vocabulary.
   * @param cwd - the fully-qualified workspace directory.
   * @param argv - the git subcommand tail (after the fixed invocation).
   * @param signal - caller lifetime; absent means the owned deadline alone applies.
   * @returns the complete stdout and retained stderr excerpt.
   * @throws {GitError} on a failed spawn, non-zero exit, or stdout overflow.
   */
  private async run(cwd: string, argv: readonly string[], signal?: AbortSignal): Promise<GitRunResult> {
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const fused = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    if (fused.aborted) {
      throw new GitError('git command was aborted before completion (deadline or caller cancellation)', 'GIT_ABORTED')
    }
    const git = await this.resolveGit()
    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: gitArgv(git, argv),
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.config.outputMaxBytes },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: this.config.graceMs,
        signal: fused,
        env: { GIT_TERMINAL_PROMPT: '0' },
      } satisfies SubprocessSpawnSpec)
    } catch (error: unknown) {
      // Node's spawn() throws synchronously for a NUL in argv, and the local
      // impl can throw synchronously when the signal aborts between the check
      // above and this call.
      /* v8 ignore start -- an abort landing exactly between the pre-check and this catch needs a mid-spawn abort race. */
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (fused.aborted) {
        throw new GitError('git command was aborted before completion (deadline or caller cancellation)', 'GIT_ABORTED')
      }
      /* v8 ignore stop */
      throw new GitError('git could not start its command (git launch failed; is git installed and on PATH?)', 'GIT_LAUNCH_FAILED', { cause: error })
    }
    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } catch (error: unknown) {
      /* v8 ignore next -- a done-rejection means the seam lost the process after a successful spawn; no real fixture produces it. */
      throw new GitError('git could not start its command (git launch failed; is git installed and on PATH?)', 'GIT_LAUNCH_FAILED', { cause: error })
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    /* v8 ignore next 2 -- the seam always collects both streams for a collect-mode spawn; a missing collector is a broken seam contract. */
    if (stdout === undefined || stderr === undefined) {
      throw new GitError('git command produced no collected output streams', 'GIT_FAILED')
    }
    // The signal can abort while the spawn is awaited; the static narrowing
    // that proves this re-check "always false" cannot see AbortSignal state.
    /* v8 ignore start -- an abort landing during the awaited run needs a mid-run abort race. */
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (fused.aborted) {
      throw new GitError('git command was aborted before completion (deadline or caller cancellation)', 'GIT_ABORTED')
    }
    /* v8 ignore stop */
    /* v8 ignore next 2 -- a signal kill needs an external kill or a mid-run deadline; the abort paths above own that vocabulary. */
    if (outcome.signal !== null || outcome.exitCode === null) {
      throw new GitError(`git command was killed by signal ${outcome.signal ?? '(unknown)'}`, 'GIT_FAILED')
    }
    if (outcome.exitCode !== 0) {
      throw classifyFailure(outcome.exitCode, stderr.text, stderr.lossy, stdout.text)
    }
    return { stdout: requireCompleteStdout(stdout, this.config.outputMaxBytes), stderr: stderr.text }
  }

  /**
   * The working-tree picture of a workspace directory.
   * @param path - fully-qualified workspace directory.
   * @param signal - caller lifetime.
   * @returns the parsed status (branch, ahead/behind, file buckets, clean flag).
   */
  async status(path: string, signal?: AbortSignal): Promise<GitStatusValue> {
    const cwd = this.resolveWorkspace(path)
    const result = await this.run(cwd, ['status', '--porcelain=v1', '-b'], signal)
    const parsed = parseStatus(result.stdout)
    return {
      ...parsed,
      clean: parsed.staged.length === 0 && parsed.unstaged.length === 0
        && parsed.untracked.length === 0 && parsed.conflicted.length === 0,
    }
  }

  /**
   * Stage every change and commit it with the given message — the quick-action
   * semantics of the GUI panel ("commit my workspace changes"), unlike the
   * model-facing tool's staged-only commit.
   * @param path - fully-qualified workspace directory.
   * @param message - the commit message (subject line).
   * @param signal - caller lifetime.
   * @returns the new commit's identity.
   */
  async commit(path: string, message: string, signal?: AbortSignal): Promise<GitCommitValue> {
    if (message.trim().length === 0) {
      throw new GitError('commit message must be a non-empty string', 'GIT_FAILED')
    }
    const cwd = this.resolveWorkspace(path)
    await this.run(cwd, ['add', '-A'], signal)
    await this.run(cwd, ['commit', '-m', message], signal)
    const follow = await this.run(cwd, ['log', '-1', `--format=${LOG_FORMAT}`], signal)
    const parsed = parseLog(follow.stdout)
    const commit = parsed[0]
    /* v8 ignore next 2 -- a successful commit always writes a log line; the arm defends against a broken follow-up read only. */
    if (commit === undefined) {
      throw new GitError('commit succeeded but the new commit could not be read', 'GIT_FAILED')
    }
    return { hash: commit.hash, shortHash: commit.shortHash, subject: commit.subject }
  }

  /**
   * Stage the given working-tree paths into the index (`git add -- <paths>`).
   * Paths are workspace-relative, exactly as `status` reports them, so the
   * panel can round-trip a row back into the index.
   * @param path - fully-qualified workspace directory.
   * @param files - workspace-relative paths to stage (non-empty).
   * @param signal - caller lifetime.
   * @returns the staged paths.
   */
  async stage(path: string, files: readonly string[], signal?: AbortSignal): Promise<{ files: string[] }> {
    if (files.length === 0) {
      throw new GitError('stage needs at least one file path', 'GIT_FAILED')
    }
    await this.run(this.resolveWorkspace(path), ['add', '--', ...files], signal)
    return { files: [...files] }
  }

  /**
   * Remove the given paths from the index, keeping the working-tree content
   * (`git restore --staged -- <paths>`).
   * @param path - fully-qualified workspace directory.
   * @param files - workspace-relative paths to unstage (non-empty).
   * @param signal - caller lifetime.
   * @returns the unstaged paths.
   */
  async unstage(path: string, files: readonly string[], signal?: AbortSignal): Promise<{ files: string[] }> {
    if (files.length === 0) {
      throw new GitError('unstage needs at least one file path', 'GIT_FAILED')
    }
    await this.run(this.resolveWorkspace(path), ['restore', '--staged', '--', ...files], signal)
    return { files: [...files] }
  }

  /**
   * Upload the current branch to its upstream remote.
   * @param path - fully-qualified workspace directory.
   * @param signal - caller lifetime.
   * @returns the retained git output (progress and confirmation).
   */
  async push(path: string, signal?: AbortSignal): Promise<GitOutputValue> {
    const result = await this.run(this.resolveWorkspace(path), ['push'], signal)
    return { output: combineOutput(result) }
  }

  /**
   * Download and integrate the current branch from its upstream remote.
   * @param path - fully-qualified workspace directory.
   * @param signal - caller lifetime.
   * @returns the retained git output (fast-forward summary and file stats).
   */
  async pull(path: string, signal?: AbortSignal): Promise<GitOutputValue> {
    const result = await this.run(this.resolveWorkspace(path), ['pull'], signal)
    return { output: combineOutput(result) }
  }

  /**
   * List the local branches of a workspace directory.
   * @param path - fully-qualified workspace directory.
   * @param signal - caller lifetime.
   * @returns the parsed branches (current, upstream, ahead/behind, `[gone]`).
   */
  async branches(path: string, signal?: AbortSignal): Promise<GitBranchValue[]> {
    const result = await this.run(this.resolveWorkspace(path), ['branch', '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)'], signal)
    return parseBranches(result.stdout)
  }

  /**
   * Switch the workspace to an existing local branch.
   * @param path - fully-qualified workspace directory.
   * @param branch - the branch to check out.
   * @param signal - caller lifetime.
   * @returns the checked-out branch name.
   */
  async checkout(path: string, branch: string, signal?: AbortSignal): Promise<{ branch: string }> {
    if (branch.trim().length === 0) {
      throw new GitError('branch must be a non-empty string', 'GIT_FAILED')
    }
    await this.run(this.resolveWorkspace(path), ['checkout', branch], signal)
    return { branch }
  }

  /**
   * Resolve and fence a wire-supplied workspace path: only fully qualified
   * paths may reach the subprocess (a relative wire value must never resolve
   * against the host cwd or, on Windows, its current drive).
   * @param path - the wire path.
   * @returns the resolved absolute directory.
   * @throws {GitError} `GIT_FAILED` when the path is not fully qualified.
   */
  private resolveWorkspace(path: string): string {
    if (!fullyQualified(path)) {
      throw new GitError(`cannot run git in "${path}": not a fully qualified path`, 'GIT_FAILED')
    }
    return resolve(path)
  }
}

/** Combine retained stdout and stderr into the one output string the panel shows. */
function combineOutput(result: GitRunResult): string {
  const stderr = result.stderr.trim()
  if (stderr.length === 0) return result.stdout
  return result.stdout.length === 0 ? stderr : `${result.stdout}\n${stderr}`
}
