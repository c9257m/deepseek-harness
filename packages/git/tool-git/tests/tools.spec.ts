/**
 * Consumer-surface tests for the git tool over a FAKE subprocess service,
 * exercised through `ctx.tools.execute()` so nothing bypasses the tool
 * registry. The fake service makes every seam outcome scriptable — spawn
 * failure, truncated stdout with/without a spill path, abort/timeout kills,
 * signal kills, non-zero exits — so these tests verify schemas, argument
 * validation, argv construction (fixed git prefix + env pin), workdir
 * derivation, the two-output acquisition shapes, deadline enforcement, and
 * `GIT_*` error classification. Real-`git` behavior is pinned separately in
 * integration.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'

const testToolSignal = new AbortController().signal

/** One scripted collect-mode stream, returned by `readFrom(0)` after settlement. */
interface ScriptedStream {
  text: string
  lossy?: boolean
  spillPath?: string
}

/** One scripted spawn: exit facts plus the collected streams the tool reads. */
interface ScriptedRun {
  outcome: SubprocessOutcome
  stdout: ScriptedStream
  stderr: ScriptedStream
}

/** A successful run over the given stdout; overrides script the failure shapes. */
function runResult(
  stdout: string,
  overrides?: Partial<SubprocessOutcome> & { stdout?: Partial<ScriptedStream>; stderr?: ScriptedStream },
): ScriptedRun {
  const { stdout: stdoutOverrides, stderr: stderrOverrides, ...outcome } = overrides ?? {}
  return {
    outcome: { exitCode: 0, signal: null, ...outcome },
    stdout: { text: stdout, ...stdoutOverrides },
    stderr: { text: '', ...stderrOverrides },
  }
}

/** A fixed-response collect-mode reader: the tools read each stream once, from 0, after settlement. */
class FakeReader implements SubprocessOutputReader {
  constructor(private readonly read: ScriptedStream) {}

  readFrom(_fromByte: number): SubprocessOutputRead {
    return {
      text: this.read.text,
      nextOffset: 0,
      lossy: this.read.lossy ?? false,
      ...this.read.spillPath !== undefined ? { spillPath: this.read.spillPath } : {},
    }
  }
}

/**
 * A scriptable subprocess handle: `done` resolves with the scripted outcome
 * (optionally after a delay, so deadline tests can observe the abort), and the
 * spec's abort signal marks the handle terminated — mirroring the seam's
 * abort→terminate escalation.
 */
class FakeHandle implements SubprocessHandle {
  readonly pid = 4242
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  /** True once `done` settled. */
  settled = false
  /** True when the handle's termination path ran (abort signal or explicit terminate). */
  terminated = false

  constructor(spec: SubprocessSpawnSpec, script: () => ScriptedRun | { reject: Error }, delayMs = 0) {
    // The abort listener attaches BEFORE the scripted run resolves, mirroring
    // a real spawn: the escalation is armed when the process starts.
    spec.signal?.addEventListener('abort', () => { this.terminated = true }, { once: true })
    const scripted = script()
    if ('reject' in scripted) {
      this.collected = {}
      this.done = Promise.reject(scripted.reject)
    } else {
      this.collected = {
        stdout: new FakeReader(scripted.stdout),
        stderr: new FakeReader(scripted.stderr),
      }
      this.done = delayMs === 0
        ? Promise.resolve(scripted.outcome)
        : new Promise((resolveDone) => {
          setTimeout(() => { resolveDone(scripted.outcome) }, delayMs)
        })
    }
    this.done.then(
      () => { this.settled = true },
      () => { this.settled = true },
    )
  }

  terminate(): void {
    this.terminated = true
  }

  waitForExit(_signal?: AbortSignal): Promise<boolean> {
    return Promise.resolve(true)
  }
}

/**
 * A scriptable fake subprocess service: `spawn()` records every spec and
 * returns a handle scripted by the armed `handler`. The git tool must only
 * spawn ordinary foreground pipes, so every test can assert on the exact
 * spawn specs and settled handles.
 */
class FakeSubprocess extends SubprocessRuntime {
  spawns: SubprocessSpawnSpec[] = []
  /** Optional per-spawn settlement delay (deadline tests). */
  delayMs = 0
  /** Optional synchronous spawn failure (a NUL-in-argv / pre-start throw). */
  throwOnSpawn: Error | null = null
  override async resolveExecutable(command: string): Promise<string> { return command }
  override spawnTerminal(): Promise<never> { throw new Error('git tool spawns pipes, never terminals') }
  handles: FakeHandle[] = []
  /** Arms the per-spawn script; a `{ reject }` return scripts a spawn-level failure. */
  handler: (spec: SubprocessSpawnSpec) => ScriptedRun | { reject: Error } = () => runResult('')

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    if (this.throwOnSpawn !== null) throw this.throwOnSpawn
    const handle = new FakeHandle(spec, () => this.handler(spec), this.delayMs)
    this.handles.push(handle)
    return handle
  }
}

async function setup(config: Partial<ToolGit.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeSubprocess)
  const subprocess = ctx.subprocess as FakeSubprocess
  const fiber = await ctx.plugin(ToolGit, config)
  return { ctx, subprocess, fiber }
}

/** A stand-in agent whose session header carries the given cwd. */
const agent = (cwd?: string) => ({ session: { header: { id: 'session-1', ...cwd !== undefined ? { cwd } : {} } } })

let callCounter = 0
function call(
  ctx: Context,
  name: string,
  args: unknown,
  options: { agent?: object; signal?: AbortSignal; parent?: ToolExecutionToken } = {},
) {
  return ctx.tools.execute({
    signal: options.signal ?? testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...options.agent ? { agent: options.agent as never } : {},
    ...options.parent ? { parent: options.parent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('registration', () => {
  it('registers the git tool with its prompt section and no load-time spawn', async () => {
    const { ctx, subprocess } = await setup()
    expect(subprocess.spawns).toHaveLength(0)
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['git'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Track changes with `git status` and `git diff` before mutating commands')
    const git = ctx.tools.schemas().find(schema => schema.name === 'git')
    expect(git?.description).toContain('pull')
    expect(git?.description).toContain('merge')
    expect(git?.description).toContain('commit')
    expect(git?.description).toContain('push')
    expect(git?.description).toContain('branch')
  })

  it('stays pending until ctx.subprocess exists (inject)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolGit)
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('unregisters everything on fiber disposal (HMR safety)', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    const sections = (await ctx.systemPrompt.assemble()).sections.map(s => s.name)
    expect(sections).not.toContain('tool:git')
  })

  it('rejects an invalid config at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeSubprocess)
    await expect(ctx.plugin(ToolGit, { timeoutMs: 0 })).rejects.toThrow(/timeoutMs/)
    await expect(ctx.plugin(ToolGit, { graceMs: Number.MAX_SAFE_INTEGER })).rejects.toThrow(/graceMs/)
    await expect(ctx.plugin(ToolGit, { textSpillMaxBytes: 1, outputMaxBytes: 100 })).rejects.toThrow(/textSpillMaxBytes/)
  })
})

describe('argument validation', () => {
  it('rejects an unknown command and a missing request', async () => {
    const { ctx } = await setup()
    const unknown = await call(ctx, 'git', { request: { command: 'rebase' } })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('invalid arguments')
    const missing = await call(ctx, 'git', {})
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('invalid arguments')
  })

  it('rejects extra keys inside a request branch (additionalProperties: false)', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'git', { request: { command: 'status', extra: 1 } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('invalid arguments')
  })

  it('rejects a blank commit message at the execute boundary', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'git', { request: { command: 'commit', message: '  ' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('message must be a non-empty string')
  })
})

describe('execution over the fake subprocess seam', () => {
  it('spawns with the fixed invocation, env pin, and session workdir', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('## main\n')
    const result = await call(ctx, 'git', { request: { command: 'status' } }, { agent: agent('/sess') })
    expect(result.isError).toBe(false)
    const spec = subprocess.spawns[0]
    expect(spec?.argv).toEqual(['git', '-c', 'color.ui=false', '-c', 'core.quotepath=false', '--no-pager', 'status', '--porcelain=v1', '-b'])
    expect(spec?.cwd).toBe('/sess')
    expect(spec?.env).toEqual({ GIT_TERMINAL_PROMPT: '0' })
    // A PARSE command requests complete stdout without a spill file.
    expect(spec?.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: ToolGit.DEFAULT_PARSE_MAX_BYTES },
      stderr: { maxBytes: ToolGit.DEFAULT_STDERR_MAX_BYTES },
    })
  })

  it('gives TEXT commands a spill-backed stdout tail', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('')
    await call(ctx, 'git', { request: { command: 'diff' } })
    const spec = subprocess.spawns[0]
    expect(spec?.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: ToolGit.DEFAULT_OUTPUT_MAX_BYTES, spill: { maxBytes: ToolGit.DEFAULT_TEXT_SPILL_MAX_BYTES } },
      stderr: { maxBytes: ToolGit.DEFAULT_STDERR_MAX_BYTES },
    })
  })

  it('resolves a relative workdir against the session cwd and keeps an absolute one', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('## main\n')
    await call(ctx, 'git', { workdir: 'repo', request: { command: 'status' } }, { agent: agent('/sess') })
    expect(subprocess.spawns[0]?.cwd).toBe(resolve('/sess', 'repo'))
    await call(ctx, 'git', { workdir: '/other/repo', request: { command: 'status' } }, { agent: agent('/sess') })
    expect(subprocess.spawns[1]?.cwd).toBe('/other/repo')
  })

  it('parses a status result into the canonical working-tree picture', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult([
      '## main...origin/main [ahead 1]',
      'M  src/a.ts',
      ' M src/b.ts',
      '?? notes.md',
    ].join('\n') + '\n')
    const { value } = await call(ctx, 'git', { request: { command: 'status' } }, { agent: agent('/sess') })
    expect(value).toEqual({
      command: 'status',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      staged: [{ path: 'src/a.ts', status: 'M' }],
      unstaged: [{ path: 'src/b.ts', status: 'M' }],
      untracked: ['notes.md'],
      conflicted: [],
    })
  })

  it('renders the status picture for the model', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('## main\nM  src/a.ts\n?? notes.md\n')
    const result = await call(ctx, 'git', {
      request: { command: 'status' },
    })
    expect(text(result)).toContain('On branch main')
    expect(text(result)).toContain('Staged: src/a.ts (M)')
    expect(text(result)).toContain('Untracked: notes.md')
  })

  it('parses a log result and renders commit lines', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('abcdefabcdefabcdefabcdefabcdefabcd\u0000abcdef0\u0000Alice\u00002026-08-15T09:30:00+08:00\u0000Add feature\n')
    const { value } = await call(ctx, 'git', { request: { command: 'log', count: 1 } }, { agent: agent('/sess') })
    expect(value).toEqual({
      command: 'log',
      truncated: false,
      commits: [{
        hash: 'abcdefabcdefabcdefabcdefabcdefabcd',
        shortHash: 'abcdef0',
        author: 'Alice',
        date: '2026-08-15T09:30:00+08:00',
        subject: 'Add feature',
      }],
    })
    const result = await call(ctx, 'git', { request: { command: 'log' } })
    expect(text(result)).toContain('abcdef0 2026-08-15 Alice — Add feature')
  })

  it('runs commit as a two-call sequence and returns the new commit identity', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = (spec) => {
      if (spec.argv.includes('commit')) return runResult('[main abc1234] fix: it\n')
      return runResult('abc1234abc1234abc1234abc1234abc1234\u0000abc1234\u0000Alice\u00002026-08-15T09:30:00+08:00\u0000fix: it\n')
    }
    const { value } = await call(ctx, 'git', { request: { command: 'commit', message: 'fix: it' } }, { agent: agent('/sess') })
    expect(subprocess.spawns.map(spec => spec.argv)).toEqual([
      ['git', '-c', 'color.ui=false', '-c', 'core.quotepath=false', '--no-pager', 'commit', '-m', 'fix: it'],
      ['git', '-c', 'color.ui=false', '-c', 'core.quotepath=false', '--no-pager', 'log', '-1', '--format=%H%x00%h%x00%an%x00%aI%x00%s'],
    ])
    expect(value).toEqual({
      command: 'commit',
      hash: 'abc1234abc1234abc1234abc1234abc1234',
      shortHash: 'abc1234',
      subject: 'fix: it',
    })
  })

  it('returns raw text with truncation facts for a diff, and renders the truncation notice', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('@@ -1 +1 @@\n-old\n+new\n', {
      stdout: { lossy: true, spillPath: '/spill/diff.txt' },
    })
    const { value } = await call(ctx, 'git', { request: { command: 'diff' } }, { agent: agent('/sess') })
    expect(value).toEqual({
      command: 'diff',
      text: '@@ -1 +1 @@\n-old\n+new\n',
      stderr: '',
      truncated: true,
      spillPath: '/spill/diff.txt',
    })
    const result = await call(ctx, 'git', { request: { command: 'diff' } })
    expect(text(result)).toContain('[output truncated; complete output saved to /spill/diff.txt]')
  })

  it('appends non-empty stderr to a raw-text result', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('', { stderr: { text: 'Updating abc1234..def5678\nFast-forward\n' } })
    const result = await call(ctx, 'git', { request: { command: 'pull' } })
    expect(text(result)).toContain('Updating abc1234..def5678')
  })

  it('renders a detached HEAD status', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('## HEAD (no branch)\n')
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(text(result)).toContain('On branch (detached HEAD)')
  })

  it('renders the tracking facts for ahead/behind status lines', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('## main...origin/main [ahead 2, behind 3]\n')
    expect(text(await call(ctx, 'git', { request: { command: 'status' } })))
      .toContain('On branch main -> origin/main (ahead 2, behind 3)')
    subprocess.handler = () => runResult('## main...origin/main [behind 1]\n')
    expect(text(await call(ctx, 'git', { request: { command: 'status' } })))
      .toContain('On branch main -> origin/main (behind 1)')
    subprocess.handler = () => runResult('## main...origin/main\n')
    expect(text(await call(ctx, 'git', { request: { command: 'status' } })))
      .toContain('On branch main -> origin/main')
  })

  it('renders an empty log as "No commits"', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('')
    const result = await call(ctx, 'git', { request: { command: 'log' } })
    expect(text(result)).toBe('No commits')
  })

  it('renders the branch listing with upstream, tracking, and gone facts', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult([
      'main\0\0origin/main\0[ahead 1, behind 2]',
      'topic\0*\0\0',
      'old\0\0origin/old\0[gone]',
    ].join('\n') + '\n')
    const result = await call(ctx, 'git', { request: { command: 'branch' } })
    expect(text(result)).toContain('  main -> origin/main [ahead 1, behind 2]')
    expect(text(result)).toContain('* topic')
    expect(text(result)).toContain('  old -> origin/old [gone]')
  })

  it('renders the staged path count with singular and plural forms', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('')
    expect(text(await call(ctx, 'git', { request: { command: 'add', paths: ['a.txt'] } })))
      .toBe('Staged 1 path.')
    expect(text(await call(ctx, 'git', { request: { command: 'add', paths: ['a.txt', 'b.txt'] } })))
      .toBe('Staged 2 paths.')
  })

  it('renders a bare truncation notice when no spill path exists', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('@@ -1 +1 @@\n-old\n+new\n', { stdout: { lossy: true } })
    const result = await call(ctx, 'git', { request: { command: 'diff' } })
    expect(text(result)).toContain('[output truncated]')
    expect(text(result)).not.toContain('saved to')
  })
})

describe('git error classification', () => {
  it('classifies a non-zero exit as GIT_FAILED with the stderr excerpt', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('', {
      exitCode: 1,
      stderr: { text: 'fatal: refusing to merge unrelated histories\n' },
    })
    const result = await call(ctx, 'git', { request: { command: 'merge', ref: 'other' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_FAILED' } })
    expect(text(result)).toContain('refusing to merge unrelated histories')
  })

  it('classifies not-a-repository stderr as GIT_NOT_A_REPOSITORY', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('', {
      exitCode: 128,
      stderr: { text: 'fatal: not a git repository (or any of the parent directories): .git\n' },
    })
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_NOT_A_REPOSITORY' } })
  })

  it('classifies a spawn-level failure as GIT_LAUNCH_FAILED', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ reject: new Error('ENOENT') })
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_LAUNCH_FAILED' } })
    expect(text(result)).toContain('git launch failed')
  })

  it('classifies a signal kill as GIT_FAILED', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('', { exitCode: null, signal: 'SIGKILL' })
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_FAILED' } })
  })

  it('classifies an outcome with neither signal nor exit code as a signal-kill GIT_FAILED', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('', { exitCode: null })
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_FAILED' } })
    expect(text(result)).toContain('killed by signal (unknown)')
  })

  it('classifies a synchronous spawn throw as GIT_LAUNCH_FAILED', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.throwOnSpawn = new Error('ENOENT')
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_LAUNCH_FAILED' } })
    expect(text(result)).toContain('git launch failed')
  })

  it('falls back to the stdout excerpt when a failed exit has no stderr', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('CONFLICT (content): Merge conflict in a.txt\n', { exitCode: 1 })
    const result = await call(ctx, 'git', { request: { command: 'merge', ref: 'other' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_FAILED' } })
    expect(text(result)).toContain('Merge conflict in a.txt')
  })

  it('omits the excerpt when a failed exit produced no output at all', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('', { exitCode: 1 })
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: git command failed (exit 1)')
  })

  it('marks the retained stderr as truncated in a failed-exit message', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('', { exitCode: 1, stderr: { text: 'fatal: boom\n', lossy: true } })
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('[stderr truncated]')
  })

  it('fails a PARSE command with GIT_OUTPUT_OVERFLOW when stdout is lossy', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => runResult('## main\n?? a\n', { stdout: { lossy: true } })
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_OUTPUT_OVERFLOW' } })
    expect(text(result)).toContain('parse cap')
  })

  it('aborts before dispatch when the caller signal is already aborted', async () => {
    const { ctx, subprocess } = await setup()
    const aborted = new AbortController()
    aborted.abort()
    const result = await call(ctx, 'git', { request: { command: 'status' } }, { signal: aborted.signal })
    // The registry rejects a pre-aborted invocation before the tool body runs.
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } })
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('terminates the process tree when the per-call deadline expires', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.delayMs = 300
    subprocess.handler = () => runResult('## main\n')
    const result = await call(ctx, 'git', {
      timeoutMs: 20,
      request: { command: 'status' },
    })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_ABORTED' } })
    // The fused deadline signal reached the spawn spec; the fake handle marks
    // itself terminated on abort, mirroring the seam escalation.
    expect(subprocess.handles[0]?.terminated).toBe(true)
  })
})

describe('isolated value contract', () => {
  it('rejects a canonical value that violates the output schema', async () => {
    const { ctx, subprocess } = await setup()
    // A status value missing the required `conflicted` array must fail output
    // validation, proving the registry enforces the declared schema.
    subprocess.handler = () => runResult('## main\n')
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next()
      return { kind: 'accept', value: { command: 'status', branch: 'main', upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] } }
    })
    const result = await call(ctx, 'git', { request: { command: 'status' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('invalid output')
  })
})

describe('runGit abort and launch-failure seams (direct calls)', () => {
  const bounds: ToolGit.GitRunBounds = {
    textMaxBytes: ToolGit.DEFAULT_OUTPUT_MAX_BYTES,
    textSpillMaxBytes: ToolGit.DEFAULT_TEXT_SPILL_MAX_BYTES,
    parseMaxBytes: ToolGit.DEFAULT_PARSE_MAX_BYTES,
    stderrMaxBytes: ToolGit.DEFAULT_STDERR_MAX_BYTES,
    graceMs: ToolGit.DEFAULT_GRACE_MS,
  }
  const exec = { name: 'git' } as unknown as ToolExecution
  const request: ToolGit.GitRunRequest = { argv: ['status', '--porcelain=v1', '-b'], workdir: '/sess', parseStdout: true }

  it('rejects before dispatch when the caller signal is already aborted', async () => {
    const { ctx, subprocess } = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(ToolGit.runGit(ctx, exec, request, bounds, controller.signal))
      .rejects.toMatchObject({ name: 'GitError', code: 'GIT_ABORTED' })
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('classifies a spawn throw racing the abort as GIT_ABORTED', async () => {
    const { ctx, subprocess } = await setup()
    const controller = new AbortController()
    subprocess.spawn = () => {
      controller.abort()
      throw new Error('late spawn')
    }
    await expect(ToolGit.runGit(ctx, exec, request, bounds, controller.signal))
      .rejects.toMatchObject({ name: 'GitError', code: 'GIT_ABORTED' })
  })
})

describe('tool-owned UI presentation (presentCall)', () => {
  it('presents the pending card as the git command line', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('git')?.presentCall?.({ request: { command: 'status' } })).toEqual({
      card: 'generic',
      title: 'git status --porcelain=v1 -b',
      kind: 'execute',
      rawInput: ['status', '--porcelain=v1', '-b'],
    })
    expect(ctx.tools.get('git')?.presentCall?.({ request: { command: 'push', remote: 'origin', branch: 'main', setUpstream: true } }))
      .toEqual({
        card: 'generic',
        title: 'git push --set-upstream origin main',
        kind: 'execute',
        rawInput: ['push', '--set-upstream', 'origin', 'main'],
      })
  })
})
