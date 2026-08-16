/**
 * Behavior of the workspace-git service over a real temporary git repository
 * and the real local subprocess service: status parsing, stage-all-and-commit,
 * push/pull against a local bare remote, branch listing/checkout, and the
 * `GitError` vocabulary (not-a-repository, relative-path rejection, unknown
 * branch, missing git). Each fixture repo gets local identity,
 * `commit.gpgsign=false`, and `core.autocrlf=false` for determinism.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import WorkspaceGit, { fullyQualified } from '@deepseek-ai/dsh-host-workspace-git'
import { GitError } from '@deepseek-ai/dsh-tool-git'

let root: string
let repo: string
let ctx: Context
let git: WorkspaceGit

function setupGit(dir: string, ...argv: string[]): string {
  return execFileSync('git', argv, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function setupRepo(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'dsh-workspace-git-'))
  repo = join(root, 'work')
  await mkdir(repo, { recursive: true })
  setupGit(repo, 'init', '-b', 'main')
  setupGit(repo, 'config', 'user.name', 'Test Author')
  setupGit(repo, 'config', 'user.email', 'test@example.com')
  setupGit(repo, 'config', 'commit.gpgsign', 'false')
  setupGit(repo, 'config', 'core.autocrlf', 'false')
}

beforeEach(async () => {
  await setupRepo()
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(WorkspaceGit)
  git = ctx.get('workspaceGit') as WorkspaceGit
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('workspace-git service over the real git binary', () => {
  it('reports a clean initialized repository with its branch', async () => {
    const status = await git.status(repo)
    expect(status.branch).toBe('main')
    expect(status.clean).toBe(true)
    expect(status.staged).toEqual([])
    expect(status.untracked).toEqual([])
    expect(status.conflicted).toEqual([])
  })

  it('tracks untracked, staged, and unstaged changes', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n')
    const untracked = await git.status(repo)
    expect(untracked.untracked).toEqual(['a.txt'])
    expect(untracked.clean).toBe(false)

    await writeFile(join(repo, 'b.txt'), 'two\n')
    setupGit(repo, 'add', 'a.txt')
    const mixed = await git.status(repo)
    expect(mixed.staged).toEqual([{ path: 'a.txt', status: 'A' }])
    expect(mixed.untracked).toEqual(['b.txt'])
    expect(mixed.clean).toBe(false)
  })

  it('stages and unstages individual paths for a selective commit', async () => {
    // An initial commit gives the unborn branch a HEAD, which
    // `git restore --staged` requires (it resolves the index against it).
    await writeFile(join(repo, 'base.txt'), 'base\n')
    await git.commit(repo, 'base')

    await writeFile(join(repo, 'a.txt'), 'one\n')
    await writeFile(join(repo, 'b.txt'), 'two\n')

    // Stage one path; the other stays untracked.
    const staged = await git.stage(repo, ['a.txt'])
    expect(staged.files).toEqual(['a.txt'])
    let status = await git.status(repo)
    expect(status.staged).toEqual([{ path: 'a.txt', status: 'A' }])
    expect(status.untracked).toEqual(['b.txt'])

    // Unstage it again; the working-tree file is untouched.
    const unstaged = await git.unstage(repo, ['a.txt'])
    expect(unstaged.files).toEqual(['a.txt'])
    status = await git.status(repo)
    expect(status.staged).toEqual([])
    expect(status.untracked).toEqual(['a.txt', 'b.txt'])
  })

  it('rejects stage/unstage without any file path', async () => {
    await expect(git.stage(repo, [])).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(git.unstage(repo, [])).rejects.toMatchObject({ code: 'GIT_FAILED' })
  })

  it('stages all changes and commits them with the given message', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await writeFile(join(repo, 'b.txt'), 'two\n')
    const commit = await git.commit(repo, 'initial import')
    expect(commit.subject).toBe('initial import')
    expect(commit.hash).toMatch(/^[0-9a-f]{40}$/)

    const status = await git.status(repo)
    expect(status.clean).toBe(true)

    // A second commit shows the identity changes (new hash).
    await writeFile(join(repo, 'a.txt'), 'changed\n')
    const second = await git.commit(repo, 'update a')
    expect(second.subject).toBe('update a')
    expect(second.hash).not.toBe(commit.hash)
  })

  it('rejects a blank commit message and a relative workspace path', async () => {
    await expect(git.commit(repo, '   ')).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(git.status('work')).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: 'cannot run git in "work": not a fully qualified path',
    })
  })

  it('lists branches and checks out another one', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git.commit(repo, 'base')
    setupGit(repo, 'branch', 'topic')

    const branches = await git.branches(repo)
    expect(branches.map(b => [b.name, b.current])).toEqual([
      ['main', true],
      ['topic', false],
    ])

    await git.checkout(repo, 'topic')
    const after = await git.branches(repo)
    expect(after.find(b => b.name === 'topic')?.current).toBe(true)

    await expect(git.checkout(repo, 'nope')).rejects.toMatchObject({ code: 'GIT_FAILED' })
  })

  it('pushes to and pulls from a local bare remote', async () => {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { encoding: 'utf8' })
    setupGit(repo, 'remote', 'add', 'origin', remote)
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git.commit(repo, 'first')
    setupGit(repo, 'push', '-u', 'origin', 'main')

    const pushed = await git.push(repo)
    expect(pushed.output).toContain('up-to-date')

    // A peer advances the remote, then the service pulls it.
    const peer = join(root, 'peer')
    execFileSync('git', ['clone', remote, peer], { encoding: 'utf8' })
    setupGit(peer, 'config', 'user.name', 'Peer')
    setupGit(peer, 'config', 'user.email', 'peer@example.com')
    await writeFile(join(peer, 'peer.txt'), 'from peer\n')
    setupGit(peer, 'add', '.')
    setupGit(peer, 'commit', '-m', 'peer change')
    setupGit(peer, 'push', 'origin', 'main')

    const pulled = await git.pull(repo)
    expect(pulled.output).toContain('peer.txt')
  })

  it('classifies a non-repository directory as GIT_NOT_A_REPOSITORY', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await expect(git.status(outside)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
  })

  it('refuses a branch switch that would overwrite local changes', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git.commit(repo, 'base')
    setupGit(repo, 'branch', 'topic')
    setupGit(repo, 'checkout', 'topic')
    await writeFile(join(repo, 'a.txt'), 'topic version\n')
    await git.commit(repo, 'topic change')
    setupGit(repo, 'checkout', 'main')
    // An uncommitted change that topic's version would overwrite blocks the switch.
    await writeFile(join(repo, 'a.txt'), 'local edit\n')
    const error = await git.checkout(repo, 'topic').then(() => undefined, (caught: unknown) => caught as GitError)
    expect(error?.code).toBe('GIT_FAILED')
    expect(error?.message).toMatch(/local changes/i)
  })

  it('rejects a blank branch name and an already-aborted caller signal', async () => {
    await expect(git.checkout(repo, '   ')).rejects.toMatchObject({ code: 'GIT_FAILED' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(git.status(repo, aborted.signal)).rejects.toMatchObject({ code: 'GIT_ABORTED' })
  })

  it('classifies a NUL in the argv as a launch failure', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await expect(git.commit(repo, 'bad\u0000message')).rejects.toMatchObject({ code: 'GIT_LAUNCH_FAILED' })
  })

  it('fails loud with GIT_OUTPUT_OVERFLOW when stdout exceeds the configured cap', async () => {
    const small = new Context()
    await small.plugin(LocalSubprocessRuntime)
    await small.plugin(WorkspaceGit, { outputMaxBytes: 32, timeoutMs: 60_000, graceMs: 3_000 })
    const smallGit = small.get('workspaceGit') as WorkspaceGit
    await writeFile(join(repo, 'a.txt'), 'one\n')
    try {
      await expect(smallGit.status(repo)).rejects.toMatchObject({ code: 'GIT_OUTPUT_OVERFLOW' })
    } finally {
      await small.fiber.dispose()
    }
  })

  it('rejects a grace period beyond the timer cap at construction', async () => {
    const bad = new Context()
    await bad.plugin(LocalSubprocessRuntime)
    await expect(bad.plugin(WorkspaceGit, {
      outputMaxBytes: 262_144, timeoutMs: 60_000, graceMs: 2_147_483_648,
    })).rejects.toThrow(/graceMs/)
    await bad.fiber.dispose()
  })

  it('reports an up-to-date pull through stdout when git writes nothing to stderr', async () => {
    const remote = join(root, 'remote2.git')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { encoding: 'utf8' })
    setupGit(repo, 'remote', 'add', 'origin', remote)
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git.commit(repo, 'first')
    setupGit(repo, 'push', '-u', 'origin', 'main')

    const pulled = await git.pull(repo)
    expect(pulled.output).toContain('up to date')
  })

  it('classifies fully qualified paths per platform', () => {
    expect(fullyQualified('/home/x', 'linux')).toBe(true)
    expect(fullyQualified('x/y', 'darwin')).toBe(false)
    expect(fullyQualified('C:\\projects', 'win32')).toBe(true)
    expect(fullyQualified('C:/projects', 'win32')).toBe(true)
    expect(fullyQualified('\\\\server\\share', 'win32')).toBe(true)
    expect(fullyQualified('//server/share/deep', 'win32')).toBe(true)
    expect(fullyQualified('relative', 'win32')).toBe(false)
    expect(fullyQualified('\\foo', 'win32')).toBe(false)
    expect(fullyQualified('/foo', 'win32')).toBe(false)
    expect(fullyQualified('C:relative', 'win32')).toBe(false)
    expect(fullyQualified('\\\\', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server\\', 'win32')).toBe(false)
  })

  it('fails loud with a precise message when git is not resolvable', async () => {
    const noGit = new Context()
    noGit.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('subprocess-local: command "git" was not found on PATH') },
      spawn: () => { throw new Error('unreachable: resolveExecutable fails first') },
    } as never)
    await noGit.plugin(WorkspaceGit)
    const noGitSvc = noGit.get('workspaceGit') as WorkspaceGit
    try {
      await expect(noGitSvc.status(repo)).rejects.toMatchObject({
        code: 'GIT_LAUNCH_FAILED',
        message: 'git could not be found: install git and ensure it is available on the PATH of the host process',
      })
    } finally {
      await noGit.fiber.dispose()
    }
  })
})
