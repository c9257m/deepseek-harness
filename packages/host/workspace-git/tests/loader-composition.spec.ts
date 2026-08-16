// Real-load-path guards for @deepseek-ai/dsh-host-workspace-git. The hand-built
// `ctx.plugin(WorkspaceGit)` suite cannot catch the composition fact that
// matters here: the service is a SERVICE-CLASS plugin whose constructor reads
// `ctx.subprocess`. A class plugin that fails to declare `static inject =
// ['subprocess']` loads fine when mounted directly on a context that already
// provides subprocess, but the Loader boot gives every plugin its OWN fiber
// with a proxied context, so an undeclared `ctx.subprocess` read throws
// `cannot get property "subprocess" without inject` the moment the service
// runs its first git operation. This spec boots a real cordis.yml composition
// through the Loader and runs a real git status, pinning the declaration.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import WorkspaceGit from '@deepseek-ai/dsh-host-workspace-git'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the workspace-git service and the services it
 * needs, exactly as the web-app composition does.
 * @returns the booted context and the fixture root directory.
 */
async function boot(): Promise<{ ctx: Context; root: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-workspace-git-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-host-workspace-git'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-host-workspace-git', WorkspaceGit],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, root }
}

describe('workspace-git real-load-path guards', () => {
  it('declares the subprocess service it reads through inject', () => {
    expect(WorkspaceGit.inject).toEqual(['subprocess'])
  })

  it('runs a real git status through a cordis.yml composition', async () => {
    const { ctx, root } = await boot()
    const git = ctx.get('workspaceGit') as WorkspaceGit

    // A real repository in the fixture workspace.
    const repo = join(root, 'work')
    await mkdir(repo)
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, encoding: 'utf8' })
    execFileSync('git', ['config', 'user.name', 'Loader Author'], { cwd: repo, encoding: 'utf8' })
    execFileSync('git', ['config', 'user.email', 'loader@example.com'], { cwd: repo, encoding: 'utf8' })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo, encoding: 'utf8' })
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo, encoding: 'utf8' })
    await writeFile(join(repo, 'tracked.txt'), 'v1\n')

    const status = await git.status(repo)
    expect(status.branch).toBe('main')
    expect(status.untracked).toEqual(['tracked.txt'])

    const commit = await git.commit(repo, 'loader commit')
    expect(commit.subject).toBe('loader commit')
    const after = await git.status(repo)
    expect(after.clean).toBe(true)
  }, 30_000)
})
