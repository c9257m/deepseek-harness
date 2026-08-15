// @vitest-environment jsdom
/**
 * FileViewer behavior over a stubbed read wire: renders the shared store's
 * open tabs with per-type badges, activates and caches per-tab content,
 * highlights code per language with an optional line-number gutter, maps Host
 * business codes onto localized error copy, and the tab/body context menus
 * close tabs and toggle the display preferences. Closing the last tab exits
 * file mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { FileViewerProps } from '../src/client/contract/slots.ts'
import { createFileBrowserStore } from '../src/client/stores.ts'
import { FileViewer } from '../src/client/FileViewer.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: FileViewerProps['t'] = makeTranslate(zh, commonZh)

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const workspaceState: WorkspaceListState = {
  items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: undefined,
}

/** A FileReadError-shaped rejection carrying the Host business code. */
function rpcFailure(code: string): Error {
  const error = new Error(code)
  ;(error as { rpcError?: { code: string; message: string } }).rpcError = { code, message: code }
  return error
}

function mount(overrides: Partial<FileViewerProps> = {}) {
  const store = createFileBrowserStore().create()
  const readFile = vi.fn(async (path: string) => path.endsWith('.ts') ? 'const answer: number = 42' : 'hello world')
  const writeFile = vi.fn(async () => {})
  const exitFileMode = vi.fn()
  const props: FileViewerProps = {
    useSessions: hook({} as never),
    useWorkspaces: hook(workspaceState),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    readFile,
    writeFile,
    exitFileMode,
    useGrammarLoaded: sel => sel(0),
    t,
    ...overrides,
  }
  const utils = render(<FileViewer {...props} />)
  return {
    store, readFile: props.readFile, writeFile: props.writeFile,
    exitFileMode: props.exitFileMode, ...utils,
  }
}

describe('FileViewer', () => {
  it('renders the empty hint while no tab is open and reads nothing', () => {
    const { readFile } = mount()
    expect(screen.getByText('从左侧文件树选择一个文件进行查看。')).toBeTruthy()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('renders tabs with per-type badges and loads the active tab\'s content', async () => {
    const { store } = mount()
    act(() => { store.actions.openFile({ path: '/workspace/src/main.ts', name: 'main.ts' }) })
    act(() => { store.actions.openFile({ path: '/workspace/README.md', name: 'README.md' }) })
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    // The most recently opened tab is active.
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    // Both tabs carry distinct per-type badges.
    expect(within(tabs[0]!).getByText('TS')).toBeTruthy()
    expect(within(tabs[1]!).getByText('M↓')).toBeTruthy()
    expect(await screen.findByText('hello world')).toBeTruthy()
  })

  it('switching tabs activates the tab and loads its content once (cached per path)', async () => {
    const { store, readFile, container } = mount()
    act(() => { store.actions.openFile({ path: '/a.ts', name: 'a.ts' }) })
    act(() => { store.actions.openFile({ path: '/b.md', name: 'b.md' }) })
    await screen.findByText('hello world')
    act(() => { fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ })) })
    // a.ts highlights, so the line text lives across token spans — wait for a
    // highlighted run and read the line's joined text.
    await waitFor(() => { expect(container.querySelector('span[style*="shiki"]')).not.toBeNull() })
    expect(readFile).toHaveBeenCalledTimes(2)
    // Back to b.md: content is cached, no re-read.
    act(() => { fireEvent.click(screen.getByRole('tab', { name: /b\.md/ })) })
    expect(await screen.findByText('hello world')).toBeTruthy()
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it('highlights code per language with a line-number gutter, and the body menu toggles both', async () => {
    const { store, container } = mount()
    act(() => { store.actions.openFile({ path: '/main.ts', name: 'main.ts' }) })
    const body = () => container.querySelector('[class*="body"]')
    // Default: highlighted token runs (inline token colors) + gutter line 1.
    await waitFor(() => { expect(container.querySelector('span[style*="shiki"]')).not.toBeNull() })
    expect(container.querySelector('[class*="gutter"]')).not.toBeNull()
    // Right-click the body: hide line numbers.
    act(() => {
      fireEvent.contextMenu(body() ?? container, { clientX: 10, clientY: 10 })
    })
    fireEvent.click(await screen.findByText('显示行号'))
    expect(container.querySelector('[class*="gutter"]')).toBeNull()
    // Right-click again: toggle highlighting off; plain text has no token spans.
    act(() => {
      fireEvent.contextMenu(body() ?? container, { clientX: 10, clientY: 10 })
    })
    fireEvent.click(await screen.findByText('语法高亮'))
    expect(container.querySelector('span[style*="shiki"]')).toBeNull()
    expect(screen.getByText('const answer: number = 42')).toBeTruthy()
  })

  it('a slow read for a switched-away tab lands in that tab\'s cache, never painting over the active tab', async () => {
    let resolveA!: (text: string) => void
    const readFile = vi.fn((path: string) => path.endsWith('a.ts')
      ? new Promise<string>((resolve) => { resolveA = resolve })
      : Promise.resolve('B'))
    const { store } = mount({ readFile: readFile as unknown as FileViewerProps['readFile'] })
    act(() => { store.actions.openFile({ path: '/a.ts', name: 'a.ts' }) })
    act(() => { store.actions.openFile({ path: '/b.ts', name: 'b.ts' }) })
    expect(await screen.findByText('B')).toBeTruthy()
    // The late settlement only fills a.ts's cache; the active tab is untouched.
    act(() => { resolveA('late a content') })
    expect(screen.getByText('B')).toBeTruthy()
    act(() => { fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ })) })
    expect(await screen.findByText('late a content')).toBeTruthy()
  })

  it('applies the mirrored font size to the code body', async () => {
    const { store, container } = mount()
    act(() => { store.actions.openFile({ path: '/main.ts', name: 'main.ts' }) })
    await waitFor(() => { expect(container.querySelector('span[style*="shiki"]')).not.toBeNull() })
    const code = () => container.querySelector('[class*="code"]') as HTMLElement
    expect(code().style.fontSize).toBe('12px')
    act(() => { store.actions.setFontSize(16) })
    expect(code().style.fontSize).toBe('16px')
  })

  it('maps Host business codes onto localized error copy', async () => {
    const { store } = mount({ readFile: vi.fn(async () => { throw rpcFailure('file-too-large') }) })
    act(() => { store.actions.openFile({ path: '/big.bin', name: 'big.bin' }) })
    expect(await screen.findByText('文件过大，无法读取。')).toBeTruthy()
  })

  it('renders the raw failure text when the rejection carries no RPC error', async () => {
    const { store } = mount({ readFile: vi.fn(async () => { throw new Error('disk detached') }) })
    act(() => { store.actions.openFile({ path: '/x', name: 'x' }) })
    expect(await screen.findByText('disk detached')).toBeTruthy()
  })

  it('the tab close button closes one tab and the last close exits file mode', async () => {
    const { store, exitFileMode } = mount()
    act(() => { store.actions.openFile({ path: '/a.ts', name: 'a.ts' }) })
    act(() => { store.actions.openFile({ path: '/b.md', name: 'b.md' }) })
    await screen.findByText('hello world')
    act(() => { fireEvent.click(screen.getByLabelText('关闭 a.ts')) })
    expect(store.getSnapshot().files).toHaveLength(1)
    expect(exitFileMode).not.toHaveBeenCalled()
    act(() => { fireEvent.click(screen.getByLabelText('关闭 b.md')) })
    expect(store.getSnapshot().files).toEqual([])
    expect(exitFileMode).toHaveBeenCalledOnce()
    expect(screen.getByText('从左侧文件树选择一个文件进行查看。')).toBeTruthy()
  })

  it('the tab context menu closes, closes others, and closes all', async () => {
    const { store, exitFileMode } = mount()
    act(() => { store.actions.openFile({ path: '/a.ts', name: 'a.ts' }) })
    act(() => { store.actions.openFile({ path: '/b.md', name: 'b.md' }) })
    act(() => { store.actions.openFile({ path: '/c.json', name: 'c.json' }) })
    // Close others from the middle tab.
    act(() => { fireEvent.contextMenu(screen.getByRole('tab', { name: /b\.md/ }), { clientX: 5, clientY: 5 }) })
    fireEvent.click(await screen.findByText('关闭其他'))
    expect(store.getSnapshot().files.map(file => file.path)).toEqual(['/b.md'])
    expect(exitFileMode).not.toHaveBeenCalled()
    // Close all from the remaining tab.
    act(() => { fireEvent.contextMenu(screen.getByRole('tab', { name: /b\.md/ }), { clientX: 5, clientY: 5 }) })
    fireEvent.click(await screen.findByText('关闭全部'))
    expect(store.getSnapshot().files).toEqual([])
    expect(exitFileMode).toHaveBeenCalledOnce()
  })

  it('edits a readable tab in a textarea and auto-saves after the debounce', async () => {
    vi.useFakeTimers()
    try {
      const { store, writeFile, container } = mount()
      act(() => { store.actions.openFile({ path: '/main.ts', name: 'main.ts' }) })
      await act(async () => {})
      // Enter edit mode: the highlighted body becomes a textarea.
      fireEvent.click(screen.getByRole('button', { name: /编辑/ }))
      const editor = () => container.querySelector('[class*="editor"]') as HTMLTextAreaElement
      expect(editor()).not.toBeNull()
      // Typing marks the tab dirty (dot) and schedules the auto-save.
      fireEvent.change(editor(), { target: { value: 'const edited = true' } })
      expect(container.querySelector('[class*="dirtyDot"]')).not.toBeNull()
      expect(writeFile).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1000) })
      await act(async () => {})
      expect(writeFile).toHaveBeenCalledWith('/main.ts', 'const edited = true')
      expect(container.querySelector('[class*="dirtyDot"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes pending edits on tab switch and close', async () => {
    vi.useFakeTimers()
    try {
      const { store, writeFile } = mount()
      act(() => { store.actions.openFile({ path: '/a.ts', name: 'a.ts' }) })
      act(() => { store.actions.openFile({ path: '/b.md', name: 'b.md' }) })
      await act(async () => {})
      // The last-opened tab is active; switch to a.ts and edit it.
      fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }))
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: /编辑/ }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited a' } })
      // Switching tabs flushes the pending save immediately (no debounce wait).
      fireEvent.click(screen.getByRole('tab', { name: /b\.md/ }))
      await act(async () => {})
      expect(writeFile).toHaveBeenCalledWith('/a.ts', 'edited a')
      // Back to a.ts, edit again, close: the close flushes too.
      fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }))
      await act(async () => {})
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited again' } })
      fireEvent.click(screen.getByLabelText('关闭 a.ts'))
      await act(async () => {})
      expect(writeFile).toHaveBeenLastCalledWith('/a.ts', 'edited again')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a save-failure bar with retry and clears it after a successful retry', async () => {
    vi.useFakeTimers()
    try {
      const { store, writeFile } = mount({
        writeFile: vi.fn()
          .mockRejectedValueOnce(new Error('disk detached'))
          .mockResolvedValueOnce(undefined),
      })
      act(() => { store.actions.openFile({ path: '/main.ts', name: 'main.ts' }) })
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: /编辑/ }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } })
      act(() => { vi.advanceTimersByTime(1000) })
      await act(async () => {})
      await act(async () => {})
      expect(screen.getByText(/保存失败：disk detached/)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await act(async () => {})
      await act(async () => {})
      expect(screen.queryByText(/保存失败/)).toBeNull()
      expect(writeFile).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
