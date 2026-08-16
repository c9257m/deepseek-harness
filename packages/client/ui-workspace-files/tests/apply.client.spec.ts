import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace-files/client'
import type { FileBrowserInjected, FileViewerInjected } from '../src/client/contract/slots.ts'
import type { FontSizeRowInjected } from '../src/client/FontSizeRow.tsx'
import { FileTree } from '../src/client/FileTree.tsx'
import { FileViewer } from '../src/client/FileViewer.tsx'
import { FontSizeRow } from '../src/client/FontSizeRow.tsx'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const listDirectory = vi.fn(async (_path?: string, _signal?: AbortSignal) => ({
    path: '/workspace', home: '/', crumbs: [], entries: [], truncated: false,
  }))
  const readFile = vi.fn(async (_path: string, _signal?: AbortSignal) => 'content')
  const writeFile = vi.fn(async (_path: string, _content: string) => {})
  const gitDiff = vi.fn(async (_path: string, _file: string, _signal?: AbortSignal) => ({
    kind: 'tracked' as const, hunks: [],
  }))
  const enterFileMode = vi.fn()
  const exitFileMode = vi.fn()
  const setFontSize = vi.fn(async (_field: string, _value: unknown) => {})
  ctx.provide('workspaces', { listDirectory, readFile, writeFile, gitDiff } as never)
  ctx.provide('layout', { openFileMode: enterFileMode, closeFileMode: exitFileMode } as never)
  // The settings scope transport: bind() returns a canned scope whose snapshot
  // carries the default font size and whose set records the row's write.
  ctx.provide('settingsScope', {
    bind: () => ({
      getSnapshot: () => ({
        status: 'ready', value: { fontSize: 12 }, base: undefined, user: undefined,
        revision: 0, writable: true, mode: 'host',
      }),
      subscribe: () => () => {},
      set: setFontSize,
      unset: vi.fn(async () => {}),
    }),
  } as never)
  ctx.provide('connection', { api: {}, isLoopback: true } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, listDirectory, readFile, writeFile, gitDiff,
    enterFileMode, exitFileMode, setFontSize,
  }
}

type HoleName = 'sidebar.files' | 'workspace.fileViewer' | 'settings.general.item'

/** Declare any subset of the holes with a single root registration ('root' is a single slot). */
function declare(slots: SlotRegistry, ...names: HoleName[]): () => void {
  const children = Object.fromEntries(names.map(name => [name, { kind: 'single', scope: 'root' }]))
  return slots.register({ name: 'root', children } as never, () => null)
}

describe('ui-workspace-files apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'workspaces', 'layout', 'connection', 'remote', 'settingsScope', 'locale'])
  })

  it('registers tree, viewer, and the font-size row for declarations arriving before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'sidebar.files')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.files')[0]!.component).toBe(FileTree)
    // Copy rides the standard locale seat: the entry declares the namespace
    // and apply registered both dictionaries.
    expect(before.slots.entries('sidebar.files')[0]!.locale).toBe('workspace-files')
    expect(before.locale.bind('workspace-files')('viewer.close')).toBe('关闭')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'workspace.fileViewer', 'settings.general.item')
    await Promise.resolve()
    expect(after.slots.entries('workspace.fileViewer')[0]!.component).toBe(FileViewer)
    expect(after.slots.entries('settings.general.item')[0]!.component).toBe(FontSizeRow)
  })

  it('routes tree actions to the browse wire and the layout mode transition', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.files')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const tree = (b.slots.entries('sidebar.files')[0]!.inject as unknown as () => FileBrowserInjected)()
    const signal = new AbortController().signal
    await tree.listDirectory('/workspace', signal)
    expect(b.listDirectory).toHaveBeenCalledWith('/workspace', signal)
    tree.enterFileMode()
    expect(b.enterFileMode).toHaveBeenCalledOnce()
  })

  it('routes viewer actions to the read/write/diff wires and the layout mode transition', async () => {
    const b = await bench()
    declare(b.slots, 'workspace.fileViewer')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const viewer = (b.slots.entries('workspace.fileViewer')[0]!.inject as unknown as () => FileViewerInjected)()
    const signal = new AbortController().signal
    await expect(viewer.readFile('/workspace/a.ts', signal)).resolves.toBe('content')
    expect(b.readFile).toHaveBeenCalledWith('/workspace/a.ts', signal)
    await viewer.writeFile('/workspace/a.ts', 'edited')
    expect(b.writeFile).toHaveBeenCalledWith('/workspace/a.ts', 'edited')
    await expect(viewer.gitDiff('/workspace', '/workspace/a.ts', signal)).resolves.toEqual({ kind: 'tracked', hunks: [] })
    expect(b.gitDiff).toHaveBeenCalledWith('/workspace', '/workspace/a.ts', signal)
    viewer.exitFileMode()
    expect(b.exitFileMode).toHaveBeenCalledOnce()
  })

  it('routes the font-size row write through the settings scope', async () => {
    const b = await bench()
    declare(b.slots, 'settings.general.item')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const row = (b.slots.entries('settings.general.item')[0]!.inject as unknown as (actions: never) => FontSizeRowInjected)(undefined as never)
    row.setFontSize(16)
    expect(b.setFontSize).toHaveBeenCalledWith('fontSize', 16)
  })

  it('teardown unwinds every registration', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.files', 'workspace.fileViewer', 'settings.general.item')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('sidebar.files')).toHaveLength(1)
    expect(b.slots.entries('workspace.fileViewer')).toHaveLength(1)
    expect(b.slots.entries('settings.general.item')).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries('sidebar.files')).toHaveLength(0)
    expect(b.slots.entries('workspace.fileViewer')).toHaveLength(0)
    expect(b.slots.entries('settings.general.item')).toHaveLength(0)
  })
})
