/**
 * Spawn execution for the git tool: the one helper that runs the system `git`
 * binary with a plain argv vector through `ctx.subprocess`, plus the
 * package-owned `GitError` vocabulary. The helper prepends the fixed git
 * invocation (`-c color.ui=false -c core.quotepath=false --no-pager`) so
 * output is deterministic plain text and non-ASCII paths stay readable, and
 * pins `GIT_TERMINAL_PROMPT=0` so a credential prompt can never hang a call.
 *
 * Two stdout acquisition shapes exist: TEXT commands (diff/push/pull/merge/
 * checkout/restore/init) request a spill-backed tail and report truncation,
 * while PARSE commands (status/log/branch/commit follow-up) require complete
 * stdout and fail with `GIT_OUTPUT_OVERFLOW` when the seam could not retain
 * it — a silently-partial porcelain stream would publish a wrong working-tree
 * picture.
 *
 * @module @deepseek-ai/dsh-tool-git/run
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Stable, machine-routable codes for git-tool failures. */
export type GitErrorCode =
  | 'GIT_FAILED'
  | 'GIT_NOT_A_REPOSITORY'
  | 'GIT_ABORTED'
  | 'GIT_LAUNCH_FAILED'
  | 'GIT_OUTPUT_OVERFLOW'

/**
 * Typed git-tool failure. Extends {@link HarnessError} so it carries a stable
 * {@link GitErrorCode} and chains `cause`; the tool registry exposes
 * `{ name, code }` on `isError` results so retry/permission/UI layers can
 * branch without parsing messages.
 */
export class GitError extends HarnessError {
  override readonly code: GitErrorCode

  constructor(message: string, code: GitErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** The retained outcome of one `git` run: streams plus the exit facts. */
export interface GitRunResult {
  /** Retained stdout text — the TAIL when `truncated`. */
  stdout: string
  /** Retained stderr tail (a diagnostic excerpt; never the success summary). */
  stderr: string
  /** The process exit code; a non-zero exit is classified before this resolves. */
  exitCode: number
  /** True when stdout bytes were dropped from `stdout`. */
  truncated: boolean
  /** Path to the spill file holding the COMPLETE stdout, when truncated and available. */
  spillPath?: string
}

/** Bounds for one git run, from plugin config. */
export interface GitRunBounds {
  /** Cap on stdout retained inline by a TEXT command (a larger stream spills). */
  textMaxBytes: number
  /** Whole-stream stdout cap for the spill file; a larger stream discards it. */
  textSpillMaxBytes: number
  /** Cap on stdout a PARSE command will accept complete; a larger stream fails. */
  parseMaxBytes: number
  /** Cap on the retained stderr diagnostic tail. */
  stderrMaxBytes: number
  /** Terminate-escalation grace period (ms) for the process tree. */
  graceMs: number
}

/** One scripted/actual run: the argv tail and where it runs. */
export interface GitRunRequest {
  /** The git subcommand and its arguments (after `git --no-pager`). */
  argv: readonly string[]
  /** The working directory the command runs in (already resolved). */
  workdir: string
  /** Whether stdout must be COMPLETE for parsing (`true`) or may spill (`false`). */
  parseStdout: boolean
}

/** Classify one non-zero `git` exit into the package error vocabulary. */
function classifyFailure(
  exitCode: number,
  stderr: string,
  stderrTruncated: boolean,
  stdout: string,
): GitError {
  // git reports some failures on stdout (merge-conflict listings) and others
  // on stderr (pathspec/not-a-repo errors); prefer stderr, fall back to stdout.
  const excerpt = (stderr.trim().length > 0 ? stderr : stdout).trim()
  const detail = excerpt.length === 0 ? '' : `: ${excerpt}${stderrTruncated ? ' [stderr truncated]' : ''}`
  if (/not a git repository/i.test(stderr)) {
    return new GitError(`not a git repository (git exited ${exitCode})${detail}`, 'GIT_NOT_A_REPOSITORY')
  }
  return new GitError(`git command failed (exit ${exitCode})${detail}`, 'GIT_FAILED')
}

/**
 * The complete retained stdout of a PARSE run, or a loud overflow failure: a
 * lossy read means the seam dropped the stream head, so the tool fails rather
 * than parse a silently-partial working-tree picture.
 */
function requireCompleteStdout(request: GitRunRequest, read: SubprocessOutputRead, parseMaxBytes: number): string {
  if (read.lossy) {
    throw new GitError(
      /* v8 ignore next -- the argv vector always starts with the git subcommand, so argv[0] is present by construction */
      `${request.argv[0] ?? 'git'} produced more output than the ${parseMaxBytes}-byte parse cap retains; narrow the operation and retry`,
      'GIT_OUTPUT_OVERFLOW',
    )
  }
  return read.text
}

/**
 * Run one `git` subcommand to completion and return its retained streams. The
 * workdir and argv are fully specified by the caller; this helper only
 * prepends the fixed invocation and the credential-prompt pin, spawns through
 * `ctx.subprocess`, classifies non-zero exits, and returns the retained
 * stdout/stderr. Cancellation and the caller's deadline come in through
 * `signal` (the seam's terminate escalation is the hard kill).
 *
 * @param ctx - the plugin context; execution uses its `subprocess` service.
 * @param exec - the tool-execution context (identity for error messages).
 * @param request - the argv tail, resolved workdir, and stdout acquisition shape.
 * @param bounds - the configured caps and grace period.
 * @param signal - the fused caller/deadline abort signal.
 * @returns the retained stdout, stderr, exit code, and truncation facts.
 */
export async function runGit(
  ctx: Context,
  exec: ToolExecution,
  request: GitRunRequest,
  bounds: GitRunBounds,
  signal: AbortSignal,
): Promise<GitRunResult> {
  if (signal.aborted) {
    throw new GitError(`${exec.name} was aborted before completion (tool timeout or caller cancellation)`, 'GIT_ABORTED')
  }
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv: ['git', '-c', 'color.ui=false', '-c', 'core.quotepath=false', '--no-pager', ...request.argv],
      cwd: request.workdir,
      stdio: {
        stdin: 'ignore',
        stdout: request.parseStdout
          ? { maxBytes: bounds.parseMaxBytes }
          : { maxBytes: bounds.textMaxBytes, spill: { maxBytes: bounds.textSpillMaxBytes } },
        stderr: { maxBytes: bounds.stderrMaxBytes },
      },
      graceMs: bounds.graceMs,
      signal,
      env: { GIT_TERMINAL_PROMPT: '0' },
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    // Node's spawn() throws synchronously for a NUL in argv, and the local
    // impl can throw synchronously when the signal aborts between the check
    // above and this call.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (signal.aborted) {
      throw new GitError(`${exec.name} was aborted before completion (tool timeout or caller cancellation)`, 'GIT_ABORTED')
    }
    throw new GitError(`${exec.name} could not start its git command (git launch failed; is git installed and on PATH?)`, 'GIT_LAUNCH_FAILED', { cause: error })
  }
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new GitError(`${exec.name} could not start its git command (git launch failed; is git installed and on PATH?)`, 'GIT_LAUNCH_FAILED', { cause: error })
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  /* v8 ignore next 2 -- the seam always collects when stdio asks for maxBytes; a handle without streams is a broken seam contract */
  if (stdout === undefined || stderr === undefined) {
    throw new GitError(`${exec.name} git command produced no collected output streams`, 'GIT_FAILED')
  }
  // The signal can abort while the spawn is awaited; the static narrowing that
  // proves this re-check "always false" cannot see AbortSignal state changes.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (signal.aborted) {
    throw new GitError(`${exec.name} was aborted before completion (tool timeout or caller cancellation)`, 'GIT_ABORTED')
  }
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new GitError(`${exec.name} git command was killed by signal ${outcome.signal ?? '(unknown)'}`, 'GIT_FAILED')
  }
  if (outcome.exitCode !== 0) {
    throw classifyFailure(outcome.exitCode, stderr.text, stderr.lossy, stdout.text)
  }
  if (request.parseStdout) {
    return {
      stdout: requireCompleteStdout(request, stdout, bounds.parseMaxBytes),
      stderr: stderr.text,
      exitCode: outcome.exitCode,
      truncated: false,
    }
  }
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: outcome.exitCode,
    truncated: stdout.lossy,
    ...stdout.spillPath !== undefined ? { spillPath: stdout.spillPath } : {},
  }
}
