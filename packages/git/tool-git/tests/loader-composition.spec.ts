// Real-load-path guards for @deepseek-ai/dsh-tool-git. Two composition facts
// the hand-built `ctx.plugin({ apply, inject })` suite cannot catch:
// 1. `tool-git` is a NAMESPACE plugin with `inject` — a stray
//    `export default apply` would make the cordis Loader's `unwrapExports`
//    collapse the module to the bare `apply`, DROPPING `inject`, and the
//    plugin would then read `ctx.subprocess` without having injected it and
//    throw the moment it loads (postmortem 0001).
// 2. The tool must boot end-to-end through a real cordis.yml composition and
//    execute a real git operation against a real repository (the
//    product-visible non-unit coverage packages/AGENTS.md requires).
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the tool-git plugin and the services it needs.
 * @returns the booted context and the fixture root directory.
 */
async function boot(): Promise<{ ctx: Context; root: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-tool-git'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-tool-git', ToolGit],
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

describe('dsh-tool-git real-load-path guards', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in ToolGit).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(ToolGit) as Record<string, unknown>
    expect(unwrapped).toBe(ToolGit)
    expect(unwrapped.name).toBe('tool-git')
    expect(unwrapped.inject).toEqual(['tools', 'systemPrompt', 'subprocess'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('runs a real git add + status through a cordis.yml composition', async () => {
    const { ctx, root } = await boot()
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('git')

    // A real repository in the fixture workspace.
    const repo = join(root, 'work')
    await mkdir(repo)
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, encoding: 'utf8' })
    execFileSync('git', ['config', 'user.name', 'Loader Author'], { cwd: repo, encoding: 'utf8' })
    execFileSync('git', ['config', 'user.email', 'loader@example.com'], { cwd: repo, encoding: 'utf8' })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo, encoding: 'utf8' })
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo, encoding: 'utf8' })
    await writeFile(join(repo, 'tracked.txt'), 'v1\n')

    const agent = { session: { header: { id: 'loader-session', cwd: repo } } }
    const execute = (args: unknown) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`loader-${Math.random().toString(36).slice(2)}`),
      name: 'git',
      arguments: args,
      agent: agent as never,
    })

    const status = await execute({ request: { command: 'status' } })
    expect(status.isError).toBe(false)
    const untracked = (status as { value: { untracked: string[] } }).value.untracked
    expect(untracked).toEqual(['tracked.txt'])

    const add = await execute({ request: { command: 'add', paths: ['tracked.txt'] } })
    expect(add.isError).toBe(false)
    expect((add as { value: { staged: string[] } }).value.staged).toEqual(['tracked.txt'])

    const commit = await execute({ request: { command: 'commit', message: 'loader commit' } })
    expect(commit.isError).toBe(false)
    expect((commit as { value: { subject: string } }).value.subject).toBe('loader commit')
  }, 30_000)
})
