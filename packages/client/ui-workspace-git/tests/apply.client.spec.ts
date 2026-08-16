import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace-git/client'
import type { GitPanelInjected } from '../src/client/contract/slots.ts'
import { GitPanel } from '../src/client/GitPanel.tsx'

usePinnedBrowserLanguages('zh-CN')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const gitStatus = vi.fn(async () => ({
    branch: 'main', upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
  }))
  const gitCommit = vi.fn(async (_path: string, message: string) => ({
    hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: message,
  }))
  const gitStage = vi.fn(async (_path: string, files: readonly string[]) => [...files])
  const gitUnstage = vi.fn(async (_path: string, files: readonly string[]) => [...files])
  const gitPush = vi.fn(async () => ({ output: '' }))
  const gitPull = vi.fn(async () => ({ output: '' }))
  const gitBranches = vi.fn(async () => [{ name: 'main', current: true, upstream: null, ahead: 0, behind: 0, gone: false }])
  const gitCheckout = vi.fn(async (_path: string, branch: string) => branch)
  ctx.provide('workspaces', { gitStatus, gitCommit, gitStage, gitUnstage, gitPush, gitPull, gitBranches, gitCheckout } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, gitStatus, gitCommit, gitStage, gitUnstage, gitPush, gitPull, gitBranches, gitCheckout }
}

describe('ui-workspace-git apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'workspaces', 'locale'])
  })

  it('registers the git panel into the file tree child hole', async () => {
    const b = await bench()
    // The parent (ui-workspace-files' FileTree entry) declares the hole.
    b.slots.register({
      name: 'root',
      children: { 'sidebar.files.git': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar.files.git')[0]?.component).toBe(GitPanel)
    expect(b.slots.entries('sidebar.files.git')[0]?.locale).toBe('workspace-git')
    expect(b.locale.bind('workspace-git')('git.commit')).toBe('提交')
  })

  it('routes panel actions to the workspaces service git methods', async () => {
    const b = await bench()
    b.slots.register({
      name: 'root',
      children: { 'sidebar.files.git': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const panel = (b.slots.entries('sidebar.files.git')[0]!.inject as unknown as () => GitPanelInjected)()
    const signal = new AbortController().signal
    await panel.gitStatus('/w', signal)
    expect(b.gitStatus).toHaveBeenCalledWith('/w', signal)
    await panel.gitCommit('/w', 'fix')
    expect(b.gitCommit).toHaveBeenCalledWith('/w', 'fix')
    await panel.gitStage('/w', ['a.ts'], signal)
    expect(b.gitStage).toHaveBeenCalledWith('/w', ['a.ts'], signal)
    await panel.gitUnstage('/w', ['a.ts'], signal)
    expect(b.gitUnstage).toHaveBeenCalledWith('/w', ['a.ts'], signal)
    await panel.gitPush('/w', signal)
    expect(b.gitPush).toHaveBeenCalledWith('/w', signal)
    await panel.gitPull('/w', signal)
    expect(b.gitPull).toHaveBeenCalledWith('/w', signal)
    await panel.gitBranches('/w', signal)
    expect(b.gitBranches).toHaveBeenCalledWith('/w', signal)
    await panel.gitCheckout('/w', 'feature')
    expect(b.gitCheckout).toHaveBeenCalledWith('/w', 'feature')
  })

  it('teardown unwinds the registration', async () => {
    const b = await bench()
    b.slots.register({
      name: 'root',
      children: { 'sidebar.files.git': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('sidebar.files.git')).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries('sidebar.files.git')).toHaveLength(0)
  })
})
