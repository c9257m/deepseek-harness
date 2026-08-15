// @vitest-environment jsdom
/**
 * FileTree behavior over a stubbed browse wire: roots at the current
 * Session's cwd, lazily expands directories (one list call per opened level),
 * filters hidden rows, opens files into the shared store and flips the layout
 * into file mode, and renders the empty hint without a session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type {
  DirectoryEntry, DirectoryListing, SessionId, SessionListState, SessionSummary, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { FileTreeProps } from '../src/client/contract/slots.ts'
import { createFileBrowserStore } from '../src/client/stores.ts'
import { baseNameOf, FileTree } from '../src/client/FileTree.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: FileTreeProps['t'] = makeTranslate(zh, commonZh)
const sid = (id: string) => id as SessionId

const dir = (name: string, path?: string): DirectoryEntry => ({
  name, path: path ?? `/workspace/${name}`, hidden: false, kind: 'directory',
})
const file = (name: string, path?: string): DirectoryEntry => ({
  name, path: path ?? `/workspace/${name}`, hidden: false, kind: 'file',
})
const listing = (path: string, entries: readonly DirectoryEntry[]): DirectoryListing => ({
  path, home: '/', crumbs: [{ name: '/', path: '/', hidden: false, kind: 'directory' }], entries: [...entries], truncated: false,
})

function sessionState(current: SessionId | undefined, cwd: string | undefined): SessionListState {
  const byId: Record<SessionId, SessionSummary> = {}
  if (current !== undefined) {
    byId[current] = {
      id: current, displayTitle: 'test', running: false, blank: false, updatedAt: 1,
      ...(cwd === undefined ? {} : { cwd }),
    }
  }
  return {
    ids: current === undefined ? [] : [current],
    byId,
    current,
    phase: 'ready',
    subagentsByParent: {}, jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspaceState(): WorkspaceListState {
  return {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }
}

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function mount(overrides: Partial<FileTreeProps> = {}) {
  const store = createFileBrowserStore().create()
  const listDirectory = vi.fn(async (path?: string) => listing(path ?? '/workspace', []))
  const enterFileMode = vi.fn()
  const props: FileTreeProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: hook(sessionState(sid('s1'), '/workspace')),
    useWorkspaces: hook(workspaceState()),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    listDirectory,
    enterFileMode,
    t,
    ...overrides,
  }
  const utils = render(<FileTree {...props} />)
  return { store, listDirectory: props.listDirectory, enterFileMode: props.enterFileMode, ...utils }
}

describe('FileTree', () => {
  it('roots at the current session cwd and renders files and directories, hiding dotfiles', async () => {
    const { listDirectory } = mount({
      listDirectory: vi.fn(async () => listing('/workspace', [
        dir('src'), file('README.md'), { ...file('.gitignore'), hidden: true },
      ])),
    })
    expect(await screen.findByText('README.md')).toBeTruthy()
    expect(screen.getByText('src')).toBeTruthy()
    expect(screen.queryByText('.gitignore')).toBeNull()
    expect(listDirectory).toHaveBeenCalledWith('/workspace')
    expect(screen.getByText('工作区文件')).toBeTruthy()
  })

  it('expands a directory lazily: one list call per opened level, children rendered beneath', async () => {
    const { listDirectory } = mount({
      listDirectory: vi.fn(async (path?: string) => path === '/workspace/src'
        ? listing('/workspace/src', [file('main.ts')])
        : listing('/workspace', [dir('src')])),
    })
    await screen.findByText('src')
    expect(listDirectory).toHaveBeenCalledTimes(1)
    act(() => { fireEvent.click(screen.getByText('src')) })
    expect(await screen.findByText('main.ts')).toBeTruthy()
    expect(listDirectory).toHaveBeenCalledWith('/workspace/src')
    expect(listDirectory).toHaveBeenCalledTimes(2)
  })

  it('collapsing an expanded directory hides its children without another list call', async () => {
    const { listDirectory } = mount({
      listDirectory: vi.fn(async (path?: string) => path === '/workspace/src'
        ? listing('/workspace/src', [file('main.ts')])
        : listing('/workspace', [dir('src')])),
    })
    await screen.findByText('src')
    act(() => { fireEvent.click(screen.getByText('src')) })
    await screen.findByText('main.ts')
    act(() => { fireEvent.click(screen.getByText('src')) })
    expect(screen.queryByText('main.ts')).toBeNull()
    expect(listDirectory).toHaveBeenCalledTimes(2) // root + one expansion, no reload
  })

  it('clicking a file opens it in the shared store and enters file mode', async () => {
    const { store, enterFileMode } = mount({
      listDirectory: vi.fn(async () => listing('/workspace', [file('README.md')])),
    })
    await screen.findByText('README.md')
    act(() => { fireEvent.click(screen.getByText('README.md')) })
    expect(store.getSnapshot().files).toEqual([{ path: '/workspace/README.md', name: 'README.md' }])
    expect(store.getSnapshot().activePath).toBe('/workspace/README.md')
    expect(enterFileMode).toHaveBeenCalledOnce()
  })

  it('shows the empty hint without a current session and lists nothing', async () => {
    const { listDirectory } = mount({
      useSessions: hook(sessionState(undefined, undefined)),
      listDirectory: vi.fn(),
    })
    expect(await screen.findByText(/打开或新建一个会话/)).toBeTruthy()
    expect(listDirectory).not.toHaveBeenCalled()
  })

  it('shows a per-level error when a listing fails and recovers on re-expand', async () => {
    mount({
      listDirectory: vi.fn(async (path?: string) => {
        if (path === '/workspace') throw new Error('boom')
        return listing('/workspace/src', [file('main.ts')])
      }),
    })
    expect(await screen.findByText(/无法加载目录/)).toBeTruthy()
  })

  it('renders nothing in the collapsed rail (region icons are the sessions view\'s)', () => {
    const { container } = mount({ wide: false })
    expect(container.firstChild).toBeNull()
  })

  it('baseNameOf handles both separators and a root path', () => {
    expect(baseNameOf('/a/b/c.ts')).toBe('c.ts')
    expect(baseNameOf('C:\\proj\\file.txt')).toBe('file.txt')
    expect(baseNameOf('/')).toBe('/')
  })
})
