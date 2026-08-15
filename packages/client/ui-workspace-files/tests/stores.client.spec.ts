// @vitest-environment jsdom
/**
 * createFileBrowserStore unit account: the open-tab list, active selection,
 * and display preferences both entries read and write. Uses the
 * test-sanctioned path: factory self-call + .create() gives the real engine
 * instance (same create path as production).
 */
import { describe, expect, it } from 'vitest'
import { createFileBrowserStore } from '@deepseek-ai/dsh-client-ui-workspace-files/src/client/stores.ts'

describe('createFileBrowserStore', () => {
  it('starts with no tabs, no selection, display preferences on, and the default font size', () => {
    const { store } = createFileBrowserStore().create()
    expect(store.getSnapshot()).toEqual({
      files: [], activePath: null, showLineNumbers: true, highlight: true, fontSize: 12,
    })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createFileBrowserStore().create()
    const b = createFileBrowserStore().create()
    a.actions.openFile({ path: '/a/b.ts', name: 'b.ts' })
    expect(a.store.getSnapshot().files).toEqual([{ path: '/a/b.ts', name: 'b.ts' }])
    expect(b.store.getSnapshot().files).toEqual([])
  })

  it('openFile appends a new tab and activates it; reopening an open file only activates', () => {
    const { store, actions } = createFileBrowserStore().create()
    actions.openFile({ path: '/a/first.ts', name: 'first.ts' })
    actions.openFile({ path: '/a/second.ts', name: 'second.ts' })
    expect(store.getSnapshot().files.map(file => file.path)).toEqual(['/a/first.ts', '/a/second.ts'])
    expect(store.getSnapshot().activePath).toBe('/a/second.ts')
    actions.openFile({ path: '/a/first.ts', name: 'first.ts' })
    expect(store.getSnapshot().files).toHaveLength(2)
    expect(store.getSnapshot().activePath).toBe('/a/first.ts')
  })

  it('activateFile switches the selection only for an open path', () => {
    const { store, actions } = createFileBrowserStore().create()
    actions.openFile({ path: '/a', name: 'a' })
    actions.openFile({ path: '/b', name: 'b' })
    actions.activateFile('/a')
    expect(store.getSnapshot().activePath).toBe('/a')
    actions.activateFile('/missing')
    expect(store.getSnapshot().activePath).toBe('/a')
  })

  it('closeFile activates the left neighbor (rightmost when the last tab closes) and clears on the final close', () => {
    const { store, actions } = createFileBrowserStore().create()
    for (const name of ['a', 'b', 'c']) actions.openFile({ path: `/${name}`, name })
    // Closing the rightmost active tab activates its left neighbor.
    actions.activateFile('/c')
    actions.closeFile('/c')
    expect(store.getSnapshot().files.map(file => file.path)).toEqual(['/a', '/b'])
    expect(store.getSnapshot().activePath).toBe('/b')
    // Closing the active middle tab activates its left neighbor.
    actions.closeFile('/b')
    expect(store.getSnapshot().files.map(file => file.path)).toEqual(['/a'])
    expect(store.getSnapshot().activePath).toBe('/a')
    // Closing the last tab clears the selection.
    actions.closeFile('/a')
    expect(store.getSnapshot()).toEqual({
      files: [], activePath: null, showLineNumbers: true, highlight: true, fontSize: 12,
    })
  })

  it('closing an inactive tab keeps the selection untouched', () => {
    const { store, actions } = createFileBrowserStore().create()
    actions.openFile({ path: '/a', name: 'a' })
    actions.openFile({ path: '/b', name: 'b' })
    actions.activateFile('/a')
    actions.closeFile('/b')
    expect(store.getSnapshot().activePath).toBe('/a')
  })

  it('closeOthers keeps only the target tab, active; closeAll clears everything', () => {
    const { store, actions } = createFileBrowserStore().create()
    for (const name of ['a', 'b', 'c']) actions.openFile({ path: `/${name}`, name })
    actions.closeOthers('/b')
    expect(store.getSnapshot().files.map(file => file.path)).toEqual(['/b'])
    expect(store.getSnapshot().activePath).toBe('/b')
    // An unknown target is a no-op.
    actions.closeOthers('/missing')
    expect(store.getSnapshot().files).toHaveLength(1)
    actions.closeAll()
    expect(store.getSnapshot().files).toEqual([])
    expect(store.getSnapshot().activePath).toBeNull()
  })

  it('the display toggles flip their preference', () => {
    const { store, actions } = createFileBrowserStore().create()
    actions.toggleLineNumbers()
    expect(store.getSnapshot().showLineNumbers).toBe(false)
    actions.toggleLineNumbers()
    expect(store.getSnapshot().showLineNumbers).toBe(true)
    actions.toggleHighlight()
    expect(store.getSnapshot().highlight).toBe(false)
  })

  it('setFontSize replaces the code font size', () => {
    const { store, actions } = createFileBrowserStore().create()
    actions.setFontSize(16)
    expect(store.getSnapshot().fontSize).toBe(16)
  })
})
