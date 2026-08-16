/**
 * Model-facing `git` tool that spawns the SYSTEM git binary through the
 * `ctx.subprocess` seam with fixed argv templates — never `ctx.shell`, never a
 * model-visible background task. The package owns schemas, argument
 * validation, argv construction, parsing, output bounds, and the deadline;
 * the subprocess seam owns spawn execution, process-tree termination,
 * environment scrubbing, and bounded output capture. Every operation runs in
 * the calling agent's session workspace by default (`workdir` overrides), and
 * each non-zero git exit is surfaced as an error carrying git's stderr.
 *
 * The tool registers one `git` entry whose `request` is an exact-one union of
 * twelve commands: `status`, `diff`, `log` (tracking the working tree and
 * history), `add`, `commit`, `push`, `pull`, `merge`, `branch`, `checkout`,
 * `restore`, and `init`.
 *
 * @module @deepseek-ai/dsh-tool-git
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-subprocess'
import { GitError, runGit } from './run.ts'
import type { GitRunBounds, GitRunResult } from './run.ts'
import { LOG_FORMAT, buildGitArgv, parsesStdout, validateGitArgs } from './commands.ts'
import type { GitRequest, GitToolArgs } from './commands.ts'
import { parseBranches, parseLog, parseStatus } from './parse.ts'
import type { BranchInfo, LogCommit, StatusFile } from './parse.ts'

export { GitError, runGit } from './run.ts'
export type { GitErrorCode, GitRunBounds, GitRunRequest, GitRunResult } from './run.ts'
export { LOG_FORMAT, buildGitArgv, parsesStdout, validateGitArgs } from './commands.ts'
export type { GitRequest, GitToolArgs } from './commands.ts'
export { parseBranches, parseFileDiff, parseLog, parseStatus } from './parse.ts'
export type { BranchInfo, DiffHunk, DiffLine, LogCommit, StatusFile, StatusInfo } from './parse.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-git'

/** Services required by the git tool. */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** Default cooperative per-call deadline budget (ms): network operations need room. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Default terminate-escalation grace period (ms) handed to the subprocess seam. */
export const DEFAULT_GRACE_MS = 3_000

/** Default cap on stdout a TEXT command (diff/push/pull/merge/checkout/restore/init) retains inline. */
export const DEFAULT_OUTPUT_MAX_BYTES = 65_536

/** Default whole-stream cap for the spill file of a TEXT command's stdout. */
export const DEFAULT_TEXT_SPILL_MAX_BYTES = 20_000_000

/** Default cap on the COMPLETE stdout a PARSE command (status/log/branch) accepts. */
export const DEFAULT_PARSE_MAX_BYTES = 2_000_000

/** Default cap on the retained stderr diagnostic tail. */
export const DEFAULT_STDERR_MAX_BYTES = 65_536

/** Default cap on commits one `log` request may ask for. */
export const DEFAULT_MAX_LOG_COMMITS = 50

/** Plugin config: execution bounds and caps (all optional — `Config` supplies defaults). */
export interface Config {
  /** Cooperative per-call deadline budget in milliseconds; a call may pass a smaller `timeoutMs` argument. */
  timeoutMs?: number
  /** Terminate-escalation grace (ms) handed to the subprocess seam, bounded by `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
  /** Cap on stdout a TEXT command retains inline; a larger stream spills and reports the spill path. */
  outputMaxBytes?: number
  /** Whole-stream cap for a TEXT command's stdout spill file. */
  textSpillMaxBytes?: number
  /** Cap on the COMPLETE stdout a PARSE command accepts; a larger stream fails with `GIT_OUTPUT_OVERFLOW`. */
  parseMaxBytes?: number
  /** Cap on the retained stderr diagnostic tail. */
  stderrMaxBytes?: number
  /** Cap on commits one `log` request may ask for. */
  maxLogCommits?: number
}

/** Runtime configuration schema for the git tool plugin. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
  outputMaxBytes: z.number().default(DEFAULT_OUTPUT_MAX_BYTES),
  textSpillMaxBytes: z.number().default(DEFAULT_TEXT_SPILL_MAX_BYTES),
  parseMaxBytes: z.number().default(DEFAULT_PARSE_MAX_BYTES),
  stderrMaxBytes: z.number().default(DEFAULT_STDERR_MAX_BYTES),
  maxLogCommits: z.number().default(DEFAULT_MAX_LOG_COMMITS),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every git-tool cap counts bytes/milliseconds/commits — a positive integer. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-git: ${name} must be a positive integer`)
  }
}

/** The canonical output union, mirroring the output schema oneOf in `apply`. */
export type GitResultValue =
  | { command: 'status'; branch: string | null; upstream: string | null; ahead: number; behind: number; staged: StatusFile[]; unstaged: StatusFile[]; untracked: string[]; conflicted: string[] }
  | { command: 'log'; commits: LogCommit[]; truncated: boolean }
  | { command: 'branch'; text: string; current: string | null; branches: BranchInfo[] }
  | { command: 'add'; staged: string[] }
  | { command: 'commit'; hash: string; shortHash: string; subject: string }
  | { command: 'diff' | 'push' | 'pull' | 'merge' | 'checkout' | 'restore' | 'init'; text: string; stderr: string; truncated: boolean; spillPath?: string }

const TOOL_DESCRIPTION = 'Run one git operation in the calling session\'s workspace and return its structured result. '
  + 'Commands: `status` (working tree picture), `diff` (uncommitted changes), `log` (commit history), `add` (stage), `commit`, `push`, `pull`, `merge`, `branch`, `checkout`, `restore`, `init`. '
  + '`status` returns the branch, ahead/behind counts, and staged/unstaged/untracked/conflicted files; '
  + '`diff` returns change text (optionally `staged`, a `stat` summary, or scoped to `path`); '
  + '`log` returns parsed commits (optionally `count` or scoped to `path`); '
  + '`add` stages `paths`; `commit` records staged changes with `message` (optionally `amend`); '
  + '`push` uploads commits (optionally to a `remote`/`branch`, or `setUpstream`); '
  + '`pull` downloads and integrates (optionally `rebase`); '
  + '`merge` merges `ref` into the current branch; '
  + '`branch` lists branches or `create`s/`delete`s one; '
  + '`checkout` switches to `branch` or creates and switches with `createBranch`; '
  + '`restore` discards working-tree or `staged` changes for `paths`; '
  + '`init` creates a repository. '
  + 'Every command runs the system git binary directly — no shell layer, so no quoting applies — '
  + 'with the calling session\'s workspace as the default working directory; pass `workdir` for another repository. '
  + 'A non-zero git exit is an error whose message carries git\'s stderr; `GIT_NOT_A_REPOSITORY` means the workdir is not inside a git repository (`init` first or choose another `workdir`).'

/** One staged/unstaged change, as the canonical output carries it. */
const FILE_CHANGE_SHAPE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    status: { type: 'string', required: true },
    from: { type: 'string' },
  },
} as const

/** The canonical `status` output: the parsed working-tree picture. */
const STATUS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true, const: 'status' },
    branch: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    upstream: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    ahead: { type: 'integer', required: true },
    behind: { type: 'integer', required: true },
    staged: { type: 'array', required: true, items: FILE_CHANGE_SHAPE },
    unstaged: { type: 'array', required: true, items: FILE_CHANGE_SHAPE },
    untracked: { type: 'array', required: true, items: { type: 'string' } },
    conflicted: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** The canonical `log` output: parsed commits plus the truncation fact. */
const LOG_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true, const: 'log' },
    commits: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hash: { type: 'string', required: true },
          shortHash: { type: 'string', required: true },
          author: { type: 'string', required: true },
          date: { type: 'string', required: true },
          subject: { type: 'string', required: true },
        },
      },
    },
    truncated: { type: 'boolean', required: true },
  },
} as const

/** The canonical `branch` output: the parsed listing (or git's raw text for create/delete). */
const BRANCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true, const: 'branch' },
    text: { type: 'string', required: true },
    current: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    branches: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          current: { type: 'boolean', required: true },
          upstream: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          ahead: { type: 'integer', required: true },
          behind: { type: 'integer', required: true },
          gone: { type: 'boolean', required: true },
        },
      },
    },
  },
} as const

/** The canonical `add` output: the paths that were staged. */
const ADD_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true, const: 'add' },
    staged: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** The canonical `commit` output: the new commit's identity. */
const COMMIT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true, const: 'commit' },
    hash: { type: 'string', required: true },
    shortHash: { type: 'string', required: true },
    subject: { type: 'string', required: true },
  },
} as const

/** Commands whose canonical output is the raw retained git text plus truncation facts. */
const TEXT_COMMANDS = ['diff', 'push', 'pull', 'merge', 'checkout', 'restore', 'init'] as const

/** The canonical raw-text output shared by every TEXT command. */
const TEXT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      required: true,
      oneOf: [
        { type: 'string', const: 'diff' },
        { type: 'string', const: 'push' },
        { type: 'string', const: 'pull' },
        { type: 'string', const: 'merge' },
        { type: 'string', const: 'checkout' },
        { type: 'string', const: 'restore' },
        { type: 'string', const: 'init' },
      ],
    },
    text: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    spillPath: { type: 'string' },
  },
} as const

/** Resolve the workdir a git call runs in: explicit (session-relative when relative), else the session cwd. */
function resolveWorkdir(requested: string | undefined, exec: ToolExecution): string {
  const sessionCwd = exec.agent?.session.header.cwd
  if (requested === undefined) return sessionCwd ?? process.cwd()
  if (sessionCwd !== undefined && !isAbsolute(requested)) return resolvePath(sessionCwd, requested)
  return requested
}

/** The configured execution bounds for the run helper. */
function bounds(resolved: ResolvedConfig): GitRunBounds {
  return {
    textMaxBytes: resolved.outputMaxBytes,
    textSpillMaxBytes: resolved.textSpillMaxBytes,
    parseMaxBytes: resolved.parseMaxBytes,
    stderrMaxBytes: resolved.stderrMaxBytes,
    graceMs: resolved.graceMs,
  }
}

/** One fused caller+deadline signal; the deadline owns the abort reason. */
function deadlineSignal(caller: AbortSignal, budgetMs: number): AbortSignal {
  return AbortSignal.any([caller, AbortSignal.timeout(budgetMs)])
}

/** A raw-text result's canonical value, with the truncation fact and spill locator. */
function textValue(command: (typeof TEXT_COMMANDS)[number], result: GitRunResult): GitResultValue {
  return {
    command,
    text: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    ...result.spillPath !== undefined ? { spillPath: result.spillPath } : {},
  }
}

/**
 * Run one validated git request to completion and produce its canonical value.
 * `commit` runs a second (parse) call to read the new commit's identity.
 */
async function runRequest(
  ctx: Context,
  exec: ToolExecution,
  request: GitRequest,
  workdir: string,
  resolved: ResolvedConfig,
  signal: AbortSignal,
): Promise<GitResultValue> {
  const runBounds = bounds(resolved)
  const argv = buildGitArgv(request)
  if (request.command === 'commit') {
    await runGit(ctx, exec, { argv, workdir, parseStdout: false }, runBounds, signal)
    // The commit exit is already a success gate; read the new HEAD's identity.
    const follow = await runGit(
      ctx, exec,
      { argv: ['log', '-1', `--format=${LOG_FORMAT}`], workdir, parseStdout: true },
      runBounds, signal,
    )
    const parsed = parseLog(follow.stdout)
    const commit = parsed[0]
    /* v8 ignore next 2 -- a successful commit always yields a log line; the arm defends against a broken follow-up read */
    if (commit === undefined) {
      throw new GitError('commit succeeded but the new commit could not be read', 'GIT_FAILED')
    }
    return { command: 'commit', hash: commit.hash, shortHash: commit.shortHash, subject: commit.subject }
  }
  const result = await runGit(
    ctx, exec,
    { argv, workdir, parseStdout: parsesStdout(request) },
    runBounds, signal,
  )
  switch (request.command) {
    case 'status':
      return { command: 'status', ...parseStatus(result.stdout) }
    case 'log':
      return { command: 'log', commits: parseLog(result.stdout), truncated: result.truncated }
    case 'branch':
      if (request.create !== undefined || request.delete !== undefined) {
        return { command: 'branch', text: result.stdout, current: null, branches: [] }
      }
      return { command: 'branch', text: '', current: null, branches: parseBranches(result.stdout) }
    case 'add':
      return { command: 'add', staged: request.paths }
    case 'diff':
    case 'push':
    case 'pull':
    case 'merge':
    case 'checkout':
    case 'restore':
    case 'init':
      return textValue(request.command, result)
    /* v8 ignore next 2 -- GitRequest is closed and every member is handled above */
    default:
      assertNever(request)
  }
}

/** Close the GitRequest union in the execution path. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(request: never): never {
  throw new Error(`unhandled git command ${JSON.stringify(request)}`)
}
/* v8 ignore stop */

/** Render the canonical status picture as model-facing lines. */
function renderStatus(status: {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: StatusFile[]
  unstaged: StatusFile[]
  untracked: string[]
  conflicted: string[]
}): string {
  const lines: string[] = []
  const branch = status.branch ?? '(detached HEAD)'
  const tracking = status.upstream === null
    ? ''
    : ` -> ${status.upstream}${status.ahead > 0 || status.behind > 0
      ? ` (${status.ahead > 0 ? `ahead ${status.ahead}` : ''}${status.ahead > 0 && status.behind > 0 ? ', ' : ''}${status.behind > 0 ? `behind ${status.behind}` : ''})`
      : ''}`
  lines.push(`On branch ${branch}${tracking}`)
  if (status.conflicted.length > 0) {
    lines.push(`Conflicts (resolve, then add and commit): ${status.conflicted.join(', ')}`)
  }
  const describe = (entry: StatusFile): string => `${entry.path} (${entry.status})`
  if (status.staged.length > 0) lines.push(`Staged: ${status.staged.map(describe).join(', ')}`)
  if (status.unstaged.length > 0) lines.push(`Unstaged: ${status.unstaged.map(describe).join(', ')}`)
  if (status.untracked.length > 0) lines.push(`Untracked: ${status.untracked.join(', ')}`)
  if (status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0 && status.conflicted.length === 0) {
    lines.push('Working tree clean')
  }
  return lines.join('\n')
}

/** Model-facing render of one canonical git result, keyed by the CALLED command. */
function renderGitResult(args: GitToolArgs, value: GitResultValue): ContentBlock[] {
  const text = (block: string): ContentBlock[] => [{ type: 'text', text: block }]
  switch (args.request.command) {
    case 'status': {
      const status = value as Extract<GitResultValue, { command: 'status' }>
      return text(renderStatus(status))
    }
    case 'log': {
      const log = value as Extract<GitResultValue, { command: 'log' }>
      const lines = log.commits.map(commit => `${commit.shortHash} ${commit.date.slice(0, 10)} ${commit.author} — ${commit.subject}`)
      return text(lines.length === 0 ? 'No commits' : lines.join('\n'))
    }
    case 'branch': {
      const branch = value as Extract<GitResultValue, { command: 'branch' }>
      if (branch.branches.length === 0) return text(branch.text.trim().length === 0 ? 'No branches' : branch.text)
      const lines = branch.branches.map((entry) => {
        const marker = entry.current ? '* ' : '  '
        const upstream = entry.upstream === null ? '' : ` -> ${entry.upstream}`
        const track = entry.gone ? ' [gone]' : entry.ahead > 0 || entry.behind > 0 ? ` [ahead ${entry.ahead}, behind ${entry.behind}]` : ''
        return `${marker}${entry.name}${upstream}${track}`
      })
      return text(lines.join('\n'))
    }
    case 'add': {
      const add = value as Extract<GitResultValue, { command: 'add' }>
      return text(`Staged ${add.staged.length} path${add.staged.length === 1 ? '' : 's'}.`)
    }
    case 'commit': {
      const commit = value as Extract<GitResultValue, { command: 'commit' }>
      return text(`Committed ${commit.shortHash}: ${commit.subject}`)
    }
    case 'diff':
    case 'push':
    case 'pull':
    case 'merge':
    case 'checkout':
    case 'restore':
    case 'init': {
      const raw = value as Extract<GitResultValue, { command: 'diff' | 'push' | 'pull' | 'merge' | 'checkout' | 'restore' | 'init' }>
      let body = raw.text
      if (raw.stderr.trim().length > 0) body = body.length === 0 ? raw.stderr : `${body}\n${raw.stderr}`
      if (raw.truncated) {
        body += raw.spillPath === undefined
          ? '\n[output truncated]'
          : `\n[output truncated; complete output saved to ${raw.spillPath}]`
      }
      return text(body.length === 0 ? '(no output)' : body)
    }
    /* v8 ignore next 2 -- GitRequest is closed and every member is handled above */
    default:
      assertNever(args.request)
  }
}

/** The model-facing command line for the pending card (display-only). */
function presentGitCall(args: GitToolArgs): ToolCallView {
  const commandLine = ['git', ...buildGitArgv(args.request)].join(' ')
  return { card: 'generic', title: commandLine, kind: 'execute', rawInput: buildGitArgv(args.request) }
}

/**
 * Register the `git` tool on `ctx.tools` and the cross-call guidance section
 * on `ctx.systemPrompt`. Execution is exclusive (git state mutations must not
 * race) and an unconfined spawn through `ctx.subprocess`; deployment policy
 * (allow/deny/ask, sandboxing) belongs to `tools/pre-execute` listeners.
 * @param ctx - the plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-git: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  assertPositiveInteger('outputMaxBytes', resolved.outputMaxBytes)
  assertPositiveInteger('textSpillMaxBytes', resolved.textSpillMaxBytes)
  if (resolved.textSpillMaxBytes < resolved.outputMaxBytes) {
    throw new Error('tool-git: textSpillMaxBytes must be no smaller than outputMaxBytes (the spill must hold the complete stream)')
  }
  assertPositiveInteger('parseMaxBytes', resolved.parseMaxBytes)
  assertPositiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)
  assertPositiveInteger('maxLogCommits', resolved.maxLogCommits)

  ctx.systemPrompt.section({
    name: 'tool:git',
    order: 105,
    text: 'Track changes with `git status` and `git diff` before mutating commands, and inspect `git status` after a failed push/pull/merge — the working tree may hold a half-applied state. Investigate the error message before retrying.',
  })

  ctx.tools.register(defineTool({
    name: 'git',
    description: TOOL_DESCRIPTION,
    parameters: {
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
      timeoutMs: { type: 'number', description: 'Cooperative deadline in milliseconds for this call. Defaults to the plugin timeout; the git process is terminated when it expires.' },
      request: {
        required: true,
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { command: { type: 'string', required: true, const: 'status' } } },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'diff' },
              staged: { type: 'boolean', description: 'Show staged (index) changes instead of unstaged working-tree changes.' },
              stat: { type: 'boolean', description: 'Show a per-file change summary instead of the full diff text.' },
              path: { type: 'string', description: 'Restrict the diff to one path.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'log' },
              count: { type: 'integer', description: 'How many commits to return (1 to the configured cap).' },
              path: { type: 'string', description: 'Restrict the history to commits touching one path.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'add' },
              paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths to stage (directories or files; "." stages everything).' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'commit' },
              message: { type: 'string', required: true, description: 'The commit message (subject line).' },
              amend: { type: 'boolean', description: 'Amend the previous commit instead of creating a new one.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'push' },
              remote: { type: 'string', description: 'Remote to push to (defaults to the branch upstream).' },
              branch: { type: 'string', description: 'Branch to push (defaults to the current branch).' },
              setUpstream: { type: 'boolean', description: 'Set the remote branch as the upstream of the pushed branch.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'pull' },
              remote: { type: 'string', description: 'Remote to pull from (defaults to the branch upstream).' },
              branch: { type: 'string', description: 'Branch to pull (defaults to the current branch).' },
              rebase: { type: 'boolean', description: 'Replay local commits on top of the fetched commits instead of merging.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'merge' },
              ref: { type: 'string', required: true, description: 'Branch, tag, or commit to merge into the current branch.' },
              noFastForward: { type: 'boolean', description: 'Create a merge commit even when the merge could fast-forward.' },
              fastForwardOnly: { type: 'boolean', description: 'Refuse to merge when a fast-forward is impossible.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'branch' },
              create: { type: 'string', description: 'Create a branch with this name (optionally from `from`).' },
              from: { type: 'string', description: 'Commit/branch the created branch starts from (defaults to HEAD).' },
              delete: { type: 'string', description: 'Delete a merged branch (use `deleteForce` to delete unmerged ones).' },
              deleteForce: { type: 'boolean', description: 'Delete the branch even when it is not merged.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'checkout' },
              branch: { type: 'string', description: 'Switch to an existing branch.' },
              createBranch: { type: 'string', description: 'Create a branch with this name and switch to it.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'restore' },
              paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths to restore (discards working-tree changes unless `staged`).' },
              staged: { type: 'boolean', description: 'Unstage paths (restore the index from HEAD) instead of restoring the working tree.' },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              command: { type: 'string', required: true, const: 'init' },
              branch: { type: 'string', description: 'Initial branch name (requires a recent git; defaults to the git default).' },
            },
          },
        ],
      },
    },
    output: {
      schema: {
        oneOf: [
          STATUS_OUTPUT,
          LOG_OUTPUT,
          BRANCH_OUTPUT,
          ADD_OUTPUT,
          COMMIT_OUTPUT,
          TEXT_OUTPUT,
        ],
      },
      render: renderGitResult,
    },
    async execute(args, exec) {
      validateGitArgs(args, resolved.maxLogCommits)
      const workdir = resolveWorkdir(args.workdir, exec)
      const signal = deadlineSignal(exec.signal, args.timeoutMs ?? resolved.timeoutMs)
      return runRequest(ctx, exec, args.request, workdir, resolved, signal)
    },
    presentCall: presentGitCall,
  }))
}
