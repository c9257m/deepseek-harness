/**
 * Integration tests: the REAL local subprocess service plus the REAL system
 * git binary, exercised through `ctx.tools.execute()`. These verify the
 * world — an actual repository is initialized, committed to, branched,
 * merged, restored, pushed, and pulled through the tool — and that git's real
 * exit/stderr vocabulary classifies into the `GIT_*` error codes. The suite
 * requires a system git on PATH (git ≥ 2.32 for the `branch` listing format)
 * and never touches the ambient user config: each fixture repo gets local
 * identity, `commit.gpgsign=false`, and `core.autocrlf=false` for
 * determinism. The fake-service suite (tools.spec.ts) carries the coverage
 * gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'

const testToolSignal = new AbortController().signal

/** Run one setup git command inside the fixture, failing the test on error. */
function git(dir: string, ...argv: string[]): string {
  return execFileSync('git', argv, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

let root: string
let repo: string
let ctx: Context

let callCounter = 0
function call(args: unknown, agentObj?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`it-${++callCounter}`),
    name: 'git',
    arguments: args,
    // Default to the fixture repo as the session cwd: without an agent the
    // tool falls back to process.cwd(), which is the harness repo itself.
    agent: (agentObj ?? agent()) as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** The fixture workspace as a session cwd, so calls default to `repo`. */
const agent = () => ({ session: { header: { id: 'session-int', cwd: repo } } })

/** Create one file with deterministic content. */
async function write(file: string, content: string): Promise<void> {
  await writeFile(join(repo, file), content)
}

async function setupRepo(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-int-'))
  repo = join(root, 'work')
  await mkdir(repo, { recursive: true })
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test Author')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
}

beforeEach(async () => {
  await setupRepo()
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolGit)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('git tool over the real git binary', () => {
  it('initializes a repository, tracks the first file, and commits it', async () => {
    // init in a non-repo directory first.
    const fresh = join(root, 'fresh')
    await mkdir(fresh)
    const freshAgent = { session: { header: { id: 's-fresh', cwd: fresh } } }
    let result = await call({ request: { command: 'init', branch: 'trunk' } }, freshAgent)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Initialized empty Git repository')

    // init again is a no-op that still succeeds.
    result = await call({ request: { command: 'status' } }, freshAgent)
    expect(result.isError).toBe(false)
    expect((result as { value: { command: 'status'; branch: string | null } }).value.branch).toBe('trunk')

    // Track the first file through the tool.
    await write('hello.txt', 'hello\n')
    result = await call({ request: { command: 'status' } })
    expect((result as { value: { untracked: string[] } }).value.untracked).toEqual(['hello.txt'])

    result = await call({ request: { command: 'add', paths: ['hello.txt'] } })
    expect(result.isError).toBe(false)
    const staged = (await call({ request: { command: 'status' } })).value as { staged: { path: string; status: string }[] }
    expect(staged.staged).toEqual([{ path: 'hello.txt', status: 'A' }])

    const committed = (await call({ request: { command: 'commit', message: 'add hello' } })).value as {
      command: 'commit'
      shortHash: string
      subject: string
      hash: string
    }
    expect(committed.command).toBe('commit')
    expect(committed.subject).toBe('add hello')
    expect(committed.hash).toMatch(/^[0-9a-f]{40}$/)

    const log = (await call({ request: { command: 'log' } })).value as { commits: { shortHash: string; subject: string }[] }
    expect(log.commits).toHaveLength(1)
    expect(log.commits[0]?.subject).toBe('add hello')
    expect(log.commits[0]?.shortHash).toBe(committed.shortHash)
  }, 30_000)

  it('tracks modifications with diff (unstaged, staged, stat, path-scoped) and restore', async () => {
    await write('a.txt', 'one\n')
    await write('b.txt', 'keep\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'base' } })

    await write('a.txt', 'two\n')
    const unstaged = (await call({ request: { command: 'diff' } })).value as { command: 'diff'; text: string }
    expect(unstaged.text).toContain('-one')
    expect(unstaged.text).toContain('+two')

    await call({ request: { command: 'add', paths: ['a.txt'] } })
    const stagedDiff = (await call({ request: { command: 'diff', staged: true } })).value as { command: 'diff'; text: string }
    expect(stagedDiff.text).toContain('-one')
    expect(stagedDiff.text).toContain('+two')

    const stat = (await call({ request: { command: 'diff', staged: true, stat: true } })).value as { command: 'diff'; text: string }
    expect(stat.text).toContain('a.txt')

    const pathDiff = (await call({ request: { command: 'diff', path: 'b.txt' } })).value as { command: 'diff'; text: string }
    expect(pathDiff.text.trim()).toBe('')

    // Unstage through restore --staged, then discard the working-tree change.
    await call({ request: { command: 'restore', paths: ['a.txt'], staged: true } })
    const unstagedAgain = (await call({ request: { command: 'status' } })).value as { staged: unknown[]; unstaged: unknown[] }
    expect(unstagedAgain.staged).toHaveLength(0)
    expect(unstagedAgain.unstaged).toHaveLength(1)

    await call({ request: { command: 'restore', paths: ['a.txt'] } })
    const clean = (await call({ request: { command: 'status' } })).value as { staged: unknown[]; unstaged: unknown[]; untracked: string[]; conflicted: string[] }
    expect(clean.staged).toHaveLength(0)
    expect(clean.unstaged).toHaveLength(0)
    expect(clean.untracked).toHaveLength(0)
    expect(clean.conflicted).toHaveLength(0)
  }, 30_000)

  it('manages branches: create, list, switch, delete, and merge', async () => {
    await write('a.txt', 'base\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'base' } })

    await call({ request: { command: 'branch', create: 'topic' } })
    await call({ request: { command: 'checkout', branch: 'topic' } })
    await write('a.txt', 'topic work\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'topic change' } })

    await call({ request: { command: 'checkout', branch: 'main' } })
    const list = (await call({ request: { command: 'branch' } })).value as {
      command: 'branch'
      branches: { name: string; current: boolean }[]
    }
    expect(list.branches.map(b => [b.name, b.current])).toEqual([
      ['main', true],
      ['topic', false],
    ])

    // A fast-forward merge (topic is strictly ahead of main).
    const merged = (await call({ request: { command: 'merge', ref: 'topic' } })).value as { command: 'merge'; text: string }
    expect(merged.command).toBe('merge')
    expect(text(await call({ request: { command: 'status' } }))).toContain('Working tree clean')

    await call({ request: { command: 'branch', delete: 'topic' } })
    const after = (await call({ request: { command: 'branch' } })).value as { branches: { name: string }[] }
    expect(after.branches.map(b => b.name)).toEqual(['main'])
  }, 30_000)

  it('creates a real merge commit with noFastForward', async () => {
    await write('a.txt', 'base\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'base' } })
    await call({ request: { command: 'branch', create: 'topic' } })
    await call({ request: { command: 'checkout', branch: 'topic' } })
    await write('b.txt', 'topic\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'topic work' } })
    await call({ request: { command: 'checkout', branch: 'main' } })

    await call({ request: { command: 'merge', ref: 'topic', noFastForward: true } })
    const log = (await call({ request: { command: 'log' } })).value as { commits: { subject: string }[] }
    expect(log.commits.map(c => c.subject)).toEqual(['Merge branch \'topic\'', 'topic work', 'base'])
  }, 30_000)

  it('surfaces a merge conflict as GIT_FAILED with the conflict listing', async () => {
    await write('a.txt', 'base\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'base' } })
    await call({ request: { command: 'branch', create: 'topic' } })
    await call({ request: { command: 'checkout', branch: 'topic' } })
    await write('a.txt', 'topic version\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'topic change' } })
    await call({ request: { command: 'checkout', branch: 'main' } })
    await write('a.txt', 'main version\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'main change' } })

    const result = await call({ request: { command: 'merge', ref: 'topic' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_FAILED' } })
    expect(text(result)).toContain('CONFLICT')
    // The conflicted file is visible to status afterwards.
    const status = (await call({ request: { command: 'status' } })).value as { conflicted: string[] }
    expect(status.conflicted).toContain('a.txt')
  }, 30_000)

  it('pushes to and pulls from a local bare remote', async () => {
    const remote = join(root, 'remote.git')
    // The bare repo's HEAD must point at the branch that will be pushed, or a
    // later clone checks out an unborn branch with no local refs.
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { encoding: 'utf8' })
    git(repo, 'remote', 'add', 'origin', remote)

    await write('a.txt', 'one\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'first' } })

    const pushResult = await call({ request: { command: 'push', setUpstream: true } })
    expect(pushResult.isError).toBe(false)
    const pushed = pushResult.value as { command: 'push'; text: string }
    expect(pushed.command).toBe('push')
    expect(pushed.text).toContain('set up to track')
    const tracked = (await call({ request: { command: 'status' } })).value as { upstream: string; ahead: number; behind: number }
    expect(tracked.upstream).toBe('origin/main')
    expect(tracked.ahead).toBe(0)
    expect(tracked.behind).toBe(0)

    // A peer advances the remote, then the tool pulls it.
    const peer = join(root, 'peer')
    execFileSync('git', ['clone', remote, peer], { encoding: 'utf8' })
    git(peer, 'config', 'user.name', 'Peer')
    git(peer, 'config', 'user.email', 'peer@example.com')
    await writeFile(join(peer, 'peer.txt'), 'from peer\n')
    git(peer, 'add', '.')
    git(peer, 'commit', '-m', 'peer change')
    git(peer, 'push', 'origin', 'main')

    const pulled = (await call({ request: { command: 'pull' } })).value as { command: 'pull'; text: string; stderr: string }
    expect(pulled.command).toBe('pull')
    const log = (await call({ request: { command: 'log', count: 1 } })).value as { commits: { subject: string }[] }
    expect(log.commits[0]?.subject).toBe('peer change')
    // The fast-forward summary lands on stderr for a non-tty pull.
    expect(pulled.text + pulled.stderr).toContain('peer.txt')
  }, 30_000)

  it('amends the previous commit', async () => {
    await write('a.txt', 'one\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    const first = (await call({ request: { command: 'commit', message: 'first draft' } })).value as { hash: string }
    await call({ request: { command: 'commit', message: 'final message', amend: true } })
    const log = (await call({ request: { command: 'log' } })).value as { commits: { subject: string; hash: string }[] }
    expect(log.commits).toHaveLength(1)
    expect(log.commits[0]?.subject).toBe('final message')
    expect(log.commits[0]?.hash).not.toBe(first.hash)
  }, 30_000)

  it('limits and scopes log with count and path', async () => {
    await write('a.txt', 'a1\n')
    await write('b.txt', 'b1\n')
    await call({ request: { command: 'add', paths: ['.'] } })
    await call({ request: { command: 'commit', message: 'both' } })
    await write('a.txt', 'a2\n')
    await call({ request: { command: 'add', paths: ['a.txt'] } })
    await call({ request: { command: 'commit', message: 'only a' } })

    const scoped = (await call({ request: { command: 'log', path: 'b.txt' } })).value as { commits: { subject: string }[] }
    expect(scoped.commits.map(c => c.subject)).toEqual(['both'])
    const counted = (await call({ request: { command: 'log', count: 1 } })).value as { commits: unknown[] }
    expect(counted.commits).toHaveLength(1)
  }, 30_000)

  it('classifies a non-repository workdir as GIT_NOT_A_REPOSITORY', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    const result = await call({ request: { command: 'status' } }, { session: { header: { id: 's-out', cwd: outside } } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_NOT_A_REPOSITORY' } })
  }, 30_000)

  it('fails checkout of an unknown branch with git stderr', async () => {
    const result = await call({ request: { command: 'checkout', branch: 'nope' } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'GitError', code: 'GIT_FAILED' } })
    expect(text(result)).toContain('did not match any file')
  }, 30_000)
})
