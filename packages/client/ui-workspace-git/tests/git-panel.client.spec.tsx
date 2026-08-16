// @vitest-environment jsdom
/**
 * GitPanel behavior: shows the branch/status summary, the changed-file
 * buckets, stages-all-and-commits through the injected wire, pushes/pulls,
 * switches branches, opens a changed file in the shared viewer through the
 * owner gestures, and degrades to the not-a-repository notice. The spec
 * asserts user-visible behavior with driven props (store + injected fakes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { GitBranchValue, GitStatusValue } from '@deepseek-ai/dsh-client-runtime/client'
import { createGitPanelStore } from '../src/client/stores.ts'
import { GitPanel } from '../src/client/GitPanel.tsx'
import type { GitPanelInjected, GitPanelProps } from '../src/client/contract/slots.ts'
import { en, zh } from '../src/client/locales.ts'

usePinnedBrowserLanguages('zh-CN')

afterEach(() => { cleanup() })

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : match
  })
}) as GitPanelProps['t']

function sessionHook(cwd: string | null) {
  const snapshot = {
    ids: cwd === null ? [] : ['s1'],
    byId: cwd === null ? {} : { s1: { id: 's1', cwd } },
    current: cwd === null ? undefined : 's1',
    phase: 'ready' as const,
  }
  return (selector: (state: typeof snapshot) => unknown): unknown => selector(snapshot)
}

const DIRTY_STATUS: GitStatusValue = {
  branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2,
  staged: [{ path: '/w/a.ts', status: 'M' }],
  unstaged: [{ path: '/w/b.ts', status: 'M' }],
  untracked: ['/w/new.txt'],
  conflicted: ['/w/conflict.txt'],
  clean: false,
}

const BRANCHES: GitBranchValue[] = [
  { name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 0, gone: false },
  { name: 'feature', current: false, upstream: null, ahead: 0, behind: 0, gone: false },
]

function mount(overrides: Partial<GitPanelInjected> = {}, cwd: string | null = '/w') {
  const store = createGitPanelStore().create()
  const gitStatus = vi.fn(async () => DIRTY_STATUS)
  const gitBranches = vi.fn(async () => BRANCHES)
  const gitCommit = vi.fn(async (_path: string, message: string) => ({
    hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: message,
  }))
  const gitStage = vi.fn(async (_path: string, files: readonly string[]) => [...files])
  const gitUnstage = vi.fn(async (_path: string, files: readonly string[]) => [...files])
  const gitPush = vi.fn(async () => ({ output: 'Everything up-to-date' }))
  const gitPull = vi.fn(async () => ({ output: 'Already up to date.' }))
  const gitCheckout = vi.fn(async (_path: string, branch: string) => branch)
  const openFile = vi.fn()
  const enterFileMode = vi.fn()
  const props: GitPanelProps = {
    useSessions: sessionHook(cwd) as never,
    useWorkspaces: (() => ({})) as never,
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    gitStatus: overrides.gitStatus ?? gitStatus,
    gitCommit: overrides.gitCommit ?? gitCommit,
    gitStage: overrides.gitStage ?? gitStage,
    gitUnstage: overrides.gitUnstage ?? gitUnstage,
    gitPush: overrides.gitPush ?? gitPush,
    gitPull: overrides.gitPull ?? gitPull,
    gitBranches: overrides.gitBranches ?? gitBranches,
    gitCheckout: overrides.gitCheckout ?? gitCheckout,
    openFile,
    enterFileMode,
    t,
  }
  const utils = render(<GitPanel {...props} />)
  const mocked = (fn: unknown) => fn as Mock
  return {
    store,
    gitStatus: mocked(overrides.gitStatus ?? gitStatus),
    gitBranches: mocked(overrides.gitBranches ?? gitBranches),
    gitCommit: mocked(overrides.gitCommit ?? gitCommit),
    gitStage: mocked(overrides.gitStage ?? gitStage),
    gitUnstage: mocked(overrides.gitUnstage ?? gitUnstage),
    gitPush: mocked(overrides.gitPush ?? gitPush),
    gitPull: mocked(overrides.gitPull ?? gitPull),
    gitCheckout: mocked(overrides.gitCheckout ?? gitCheckout),
    openFile,
    enterFileMode,
    ...utils,
  }
}

describe('GitPanel', () => {
  it('renders nothing without a session workspace', () => {
    const { container } = mount({}, null)
    expect(container.firstChild).toBeNull()
  })

  it('loads and shows the branch, tracking facts, and changed-file buckets', async () => {
    const { gitStatus, gitBranches } = mount()
    expect(await screen.findByTitle('main')).toBeTruthy()
    expect(screen.getByText(/领先 1/)).toBeTruthy()
    expect(screen.getByText(/落后 2/)).toBeTruthy()
    expect(screen.getByText('已暂存 (1)')).toBeTruthy()
    expect(screen.getByText('未暂存 (1)')).toBeTruthy()
    expect(screen.getByText('未跟踪 (1)')).toBeTruthy()
    expect(screen.getByText('冲突 (1)')).toBeTruthy()
    expect(screen.getByText('M a.ts')).toBeTruthy()
    expect(gitStatus).toHaveBeenCalledWith('/w', expect.any(AbortSignal))
    expect(gitBranches).toHaveBeenCalledWith('/w', expect.any(AbortSignal))
  })

  it('shows the clean state when the workspace has no changes', async () => {
    mount({
      gitStatus: vi.fn(async () => ({
        branch: 'main', upstream: null, ahead: 0, behind: 0,
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      })),
    })
    expect(await screen.findByText('工作区干净')).toBeTruthy()
    expect(screen.queryByText('已暂存 (1)')).toBeNull()
  })

  it('collapses to the header row and expands back, keeping the stored flag', async () => {
    const { store } = mount({
      gitStatus: vi.fn(async () => ({
        branch: 'main', upstream: null, ahead: 0, behind: 0,
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      })),
    })
    await screen.findByTitle('main')
    // Expanded by default: the body is visible, the toggle says 收起.
    expect(screen.getByText('工作区干净')).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(store.getSnapshot().collapsed).toBe(true)
    // The body is gone; only the header toggle remains, now labelled 展开.
    expect(screen.queryByText('工作区干净')).toBeNull()
    expect(screen.queryByRole('button', { name: '提交' })).toBeNull()
    const expand = screen.getByRole('button', { name: '展开' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(expand)
    expect(store.getSnapshot().collapsed).toBe(false)
    expect(await screen.findByText('工作区干净')).toBeTruthy()
  })

  it('commits the draft message through the stage-all wire and reports the commit', async () => {
    const { gitCommit, store } = mount()
    await screen.findByTitle('main')
    fireEvent.change(screen.getByPlaceholderText('提交信息…'), { target: { value: 'fix the bug' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => { expect(gitCommit).toHaveBeenCalledWith('/w', 'fix the bug') })
    await waitFor(() => { expect(screen.getByText('已提交 aaaaaaa')).toBeTruthy() })
    expect(store.getSnapshot().commitMessage).toBe('')
  })

  it('stages an unstaged file through the wire', async () => {
    const { gitStage } = mount()
    await screen.findByTitle('main')
    fireEvent.click(within(screen.getByTitle('/w/b.ts')).getByRole('button', { name: '暂存' }))
    await waitFor(() => { expect(gitStage).toHaveBeenCalledWith('/w', ['/w/b.ts'], expect.any(AbortSignal)) })
    await waitFor(() => { expect(screen.getByText('已暂存 1 个文件')).toBeTruthy() })
  })

  it('unstages a staged file through the wire', async () => {
    const { gitUnstage } = mount()
    await screen.findByTitle('main')
    fireEvent.click(within(screen.getByTitle('/w/a.ts')).getByRole('button', { name: '取消暂存' }))
    await waitFor(() => { expect(gitUnstage).toHaveBeenCalledWith('/w', ['/w/a.ts'], expect.any(AbortSignal)) })
    await waitFor(() => { expect(screen.getByText('已取消暂存 1 个文件')).toBeTruthy() })
  })

  it('stages every path of the unstaged bucket through the batch button', async () => {
    const { gitStage } = mount()
    await screen.findByTitle('main')
    // Two batch buttons exist (unstaged + untracked); scope to the unstaged bucket.
    fireEvent.click(within(screen.getByTitle('/w/b.ts').closest('div') as HTMLElement)
      .getByRole('button', { name: '全部暂存' }))
    await waitFor(() => { expect(gitStage).toHaveBeenCalledWith('/w', ['/w/b.ts'], expect.any(AbortSignal)) })
  })

  it('unstages every path of the staged bucket through the batch button', async () => {
    const { gitUnstage } = mount()
    await screen.findByTitle('main')
    fireEvent.click(within(screen.getByTitle('/w/a.ts').closest('div') as HTMLElement)
      .getByRole('button', { name: '全部取消暂存' }))
    await waitFor(() => { expect(gitUnstage).toHaveBeenCalledWith('/w', ['/w/a.ts'], expect.any(AbortSignal)) })
  })

  it('opens a changed file in the shared viewer when its row is clicked', async () => {
    const { openFile, enterFileMode } = mount()
    await screen.findByTitle('main')
    fireEvent.click(screen.getByText('M a.ts'))
    expect(openFile).toHaveBeenCalledWith({ path: '/w/a.ts', name: 'a.ts' })
    expect(enterFileMode).toHaveBeenCalledOnce()
  })

  it('resolves workspace-relative git paths against the session cwd before opening', async () => {
    const { openFile } = mount({
      gitStatus: vi.fn(async () => ({
        branch: 'main', upstream: null, ahead: 0, behind: 0,
        staged: [], unstaged: [{ path: 'src/b.ts', status: 'M' }], untracked: [], conflicted: [], clean: false,
      })),
    })
    await screen.findByText('M b.ts')
    fireEvent.click(screen.getByText('M b.ts'))
    expect(openFile).toHaveBeenCalledWith({ path: '/w/src/b.ts', name: 'b.ts' })
  })

  it('pushes and pulls through the wire, showing the acknowledgement', async () => {
    const { gitPush, gitPull } = mount()
    await screen.findByTitle('main')
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    await waitFor(() => { expect(gitPush).toHaveBeenCalledWith('/w', expect.any(AbortSignal)) })
    await waitFor(() => { expect(screen.getByText('推送完成')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '拉取' }))
    await waitFor(() => { expect(gitPull).toHaveBeenCalledWith('/w', expect.any(AbortSignal)) })
    await waitFor(() => { expect(screen.getByText('拉取完成')).toBeTruthy() })
  })

  it('lists branches with the current one marked and switches on click', async () => {
    const { gitCheckout } = mount()
    await screen.findByTitle('main')
    // Every branch is listed; the current one is marked and disabled.
    expect(screen.getByText('分支')).toBeTruthy()
    expect(screen.getByText('当前分支')).toBeTruthy()
    const current = screen.getByRole('button', { name: 'main当前分支' })
    expect((current as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'feature' }))
    await waitFor(() => { expect(gitCheckout).toHaveBeenCalledWith('/w', 'feature') })
  })

  it('drags the changes-list resize handle to adjust its stored height', async () => {
    const { store } = mount()
    await screen.findByTitle('main')
    const handle = screen.getByRole('separator', { name: '拖动调整变更列表高度' })
    fireEvent.pointerDown(handle, { clientY: 100 })
    fireEvent.pointerMove(window, { clientY: 160 })
    fireEvent.pointerUp(window)
    expect(store.getSnapshot().changesHeight).toBe(220)
    // The stored height survives a remount (the store is shared).
    expect(screen.getByRole('separator', { name: '拖动调整变更列表高度' })).toBeTruthy()
  })

  it('clamps the dragged changes-list height to the panel bounds', async () => {
    const { store } = mount()
    await screen.findByTitle('main')
    const handle = screen.getByRole('separator', { name: '拖动调整变更列表高度' })
    // A huge drag clamps to the maximum.
    fireEvent.pointerDown(handle, { clientY: 0 })
    fireEvent.pointerMove(window, { clientY: 5000 })
    fireEvent.pointerUp(window)
    expect(store.getSnapshot().changesHeight).toBe(480)
    // A negative drag clamps to the minimum.
    fireEvent.pointerDown(handle, { clientY: 100 })
    fireEvent.pointerMove(window, { clientY: -5000 })
    fireEvent.pointerUp(window)
    expect(store.getSnapshot().changesHeight).toBe(72)
  })

  it('surfaces a failed operation in the error row', async () => {
    const { store } = mount({
      gitPush: vi.fn(async () => {
        throw new Error('git operation failed: git-failed: rejected')
      }),
    })
    await screen.findByTitle('main')
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(screen.getByText(/rejected/)).toBeTruthy()
    expect(store.getSnapshot().error).toContain('git-failed')
  })

  it('shows the not-a-repository notice when the workspace is not a repo', async () => {
    mount({
      gitStatus: vi.fn(async () => {
        throw new Error('git operation failed: git-not-a-repository: not a git repository')
      }),
      gitBranches: vi.fn(async () => []),
    })
    expect(await screen.findByText('不是 git 仓库')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提交' })).toBeNull()
  })

  it('refreshes status and branches on the refresh button', async () => {
    const { gitStatus, gitBranches } = mount()
    await screen.findByTitle('main')
    const calls = gitStatus.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(gitStatus.mock.calls.length).toBe(calls + 1) })
    expect(gitBranches.mock.calls.length).toBe(2)
  })

  it('ignores a second action while one is in flight (busy guard)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { store, gitPush } = mount({
      gitPush: vi.fn(async () => { await gate; return { output: '' } }),
    })
    await screen.findByTitle('main')
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    // Flush the re-render the busy update schedules; the action buttons then
    // disable, and a click on a disabled button is a no-op.
    await act(async () => {})
    expect(store.getSnapshot().busy).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '推送' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    await waitFor(() => { expect(gitPush).toHaveBeenCalledTimes(1) })
    release()
  })

  it('omits buckets with no files and marks a detached HEAD', async () => {
    mount({
      gitStatus: vi.fn(async () => ({
        branch: null, upstream: null, ahead: 0, behind: 0,
        staged: [{ path: '/w/a.ts', status: 'M' }],
        unstaged: [], untracked: ['/w/new.txt'], conflicted: [], clean: false,
      })),
    })
    expect(await screen.findByText('游离 HEAD')).toBeTruthy()
    expect(screen.getByText('已暂存 (1)')).toBeTruthy()
    expect(screen.queryByText('冲突 (0)')).toBeNull()
    expect(screen.queryByText('未暂存 (0)')).toBeNull()
  })

  it('caps a bucket at 20 paths with a +N overflow marker', async () => {
    const untracked = Array.from({ length: 23 }, (_, index) => `/w/u-${index}.txt`)
    mount({
      gitStatus: vi.fn(async () => ({
        branch: 'main', upstream: null, ahead: 0, behind: 0,
        staged: [], unstaged: [], untracked, conflicted: [], clean: false,
      })),
    })
    expect(await screen.findByText('未跟踪 (23)')).toBeTruthy()
    expect(screen.getByText('+3')).toBeTruthy()
  })

  it('hides the branch list when no branches are listed', async () => {
    const { gitStatus } = mount({ gitBranches: vi.fn(async () => []) })
    await waitFor(() => { expect(gitStatus).toHaveBeenCalled() })
    await screen.findByTitle('main')
    expect(screen.queryByText('分支')).toBeNull()
  })

  it('commits on Enter and ignores other keys in the message input', async () => {
    const { gitCommit } = mount()
    await screen.findByTitle('main')
    const input = screen.getByPlaceholderText('提交信息…')
    fireEvent.change(input, { target: { value: 'enter commit' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(gitCommit).toHaveBeenCalledWith('/w', 'enter commit') })
    fireEvent.keyDown(input, { key: 'a' })
    expect(gitCommit).toHaveBeenCalledTimes(1)
  })

  it('refuses a commit via Enter while an operation is in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { store, gitCommit } = mount({
      gitPush: vi.fn(async () => { await gate; return { output: '' } }),
    })
    await screen.findByTitle('main')
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    await act(async () => {})
    expect(store.getSnapshot().busy).toBe(true)
    const input = screen.getByPlaceholderText('提交信息…')
    fireEvent.change(input, { target: { value: 'during push' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(gitCommit).not.toHaveBeenCalled()
    release()
  })

  it('supersedes a slower earlier status load when refreshed', async () => {
    const statusGates: Array<(status: GitStatusValue) => void> = []
    const { store } = mount({
      gitStatus: vi.fn(() => new Promise<GitStatusValue>((resolve) => { statusGates.push(resolve) })),
    })
    // Load #1 (seq 1): status pending; branches resolve fresh.
    await waitFor(() => { expect(store.getSnapshot().branches.length).toBe(2) })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    // Load #2 (seq 2) starts; resolving load #1's status must be discarded.
    await act(async () => {})
    statusGates[0]!(DIRTY_STATUS)
    await act(async () => {})
    expect(store.getSnapshot().status).toBeNull()
    statusGates[1]!(DIRTY_STATUS)
    await waitFor(() => { expect(store.getSnapshot().status?.branch).toBe('main') })
  })

  it('discards a rejected status load superseded by a refresh', async () => {
    const statusGates: Array<(reject: (reason: Error) => void) => void> = []
    const { store } = mount({
      gitStatus: vi.fn(() => new Promise<GitStatusValue>((_resolve, reject) => { statusGates.push(reject) })),
    })
    await waitFor(() => { expect(store.getSnapshot().branches.length).toBe(2) })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await act(async () => {})
    // The superseded load's failure must not surface an error for the new root.
    statusGates[0]!(() => { throw new Error('git operation failed: git-failed: old root') })
    await act(async () => {})
    expect(store.getSnapshot().error).toBeNull()
    expect(store.getSnapshot().status).toBeNull()
  })

  it('supersedes a slower earlier branch load when refreshed', async () => {
    const branchGates: Array<(branches: GitBranchValue[]) => void> = []
    const { store } = mount({
      gitStatus: vi.fn(async () => DIRTY_STATUS),
      gitBranches: vi.fn(() => new Promise<GitBranchValue[]>((resolve) => { branchGates.push(resolve) })),
    })
    // Load #1: status fresh; branches pending.
    await waitFor(() => { expect(store.getSnapshot().status?.branch).toBe('main') })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await act(async () => {})
    branchGates[0]!([{ name: 'old', current: true, upstream: null, ahead: 0, behind: 0, gone: false }])
    await act(async () => {})
    expect(store.getSnapshot().branches).toEqual([])
    branchGates[1]!(BRANCHES)
    await waitFor(() => { expect(store.getSnapshot().branches.length).toBe(2) })
  })

  it('clears the branch list when the branch load fails', async () => {
    const { store } = mount({
      gitBranches: vi.fn(async () => { throw new Error('git operation failed: git-failed: cannot list') }),
    })
    await waitFor(() => { expect(store.getSnapshot().branches).toEqual([]) })
    expect(screen.queryByText('分支')).toBeNull()
  })

  it('discards a rejected branch load superseded by a refresh', async () => {
    const branchGates: Array<(reject: (reason: Error) => void) => void> = []
    const { store } = mount({
      gitStatus: vi.fn(async () => DIRTY_STATUS),
      gitBranches: vi.fn(() => new Promise<GitBranchValue[]>((_resolve, reject) => { branchGates.push(reject) })),
    })
    await waitFor(() => { expect(store.getSnapshot().status?.branch).toBe('main') })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await act(async () => {})
    // The superseded load's branch failure must not clear the fresh list.
    branchGates[0]!(() => { throw new Error('git operation failed: git-failed: old root') })
    await act(async () => {})
    expect(store.getSnapshot().branches).toEqual([])
  })

  it('shows a load-time git failure (other than not-a-repository) in the error row', async () => {
    const { store } = mount({
      gitStatus: vi.fn(async () => {
        throw new Error('git operation failed: git-launch-failed: git is not installed')
      }),
    })
    await waitFor(() => { expect(store.getSnapshot().error).toContain('git-launch-failed') })
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})

// The English dictionary mirrors the Chinese key set (structural parity).
describe('locales', () => {
  it('mirrors the Chinese key set in English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
