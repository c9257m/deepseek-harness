/**
 * The git panel's shared store: the loaded status and branch facts plus the
 * panel-local interaction state (commit draft, busy flag, last output/error).
 * The panel is the only reader and writer; the store exists so the facts
 * survive remounts and stay out of component state.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { GitBranchValue, GitStatusValue } from '@deepseek-ai/dsh-client-runtime/client'

/** Panel state: the parsed git picture and the interaction draft. */
export type GitPanelState = {
  /** The parsed working-tree picture; null before the first load. */
  status: GitStatusValue | null
  /** The local branches of the workspace. */
  branches: readonly GitBranchValue[]
  /** The commit-message draft. */
  commitMessage: string
  /** True while a git operation is in flight (disables the actions). */
  busy: boolean
  /** The last successful operation's output (push/pull/commit acknowledgement). */
  output: string | null
  /** The last failed operation's message. */
  error: string | null
  /** True when the workspace is not inside a git repository. */
  notRepo: boolean
  /** The drag-adjustable height (px) of the changed-files area; survives remounts. */
  changesHeight: number
}

/** Annotation twin of the actions literal below. */
type GitPanelActions = {
  setStatus: (draft: GitPanelState, status: GitStatusValue | null) => void
  setBranches: (draft: GitPanelState, branches: readonly GitBranchValue[]) => void
  setCommitMessage: (draft: GitPanelState, message: string) => void
  setBusy: (draft: GitPanelState, busy: boolean) => void
  setOutput: (draft: GitPanelState, output: string | null) => void
  setError: (draft: GitPanelState, error: string | null) => void
  setNotRepo: (draft: GitPanelState, notRepo: boolean) => void
  setChangesHeight: (draft: GitPanelState, height: number) => void
}

/** Default height (px) of the changed-files area before the user drags it. */
export const DEFAULT_CHANGES_HEIGHT = 160

/** The smallest height (px) the changed-files area may be dragged to. */
export const MIN_CHANGES_HEIGHT = 72

/** The largest height (px) the changed-files area may be dragged to. */
export const MAX_CHANGES_HEIGHT = 480

/**
 * Create the git panel store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createGitPanelStore(): EngineStoreHandle<GitPanelState, GitPanelActions> {
  return defineStore({
    init: (): GitPanelState => ({
      status: null, branches: [], commitMessage: '', busy: false, output: null, error: null, notRepo: false,
      changesHeight: DEFAULT_CHANGES_HEIGHT,
    }),
    actions: {
      setStatus: (draft, status) => { draft.status = status },
      setBranches: (draft, branches) => { draft.branches = branches },
      setCommitMessage: (draft, message) => { draft.commitMessage = message },
      setBusy: (draft, busy) => { draft.busy = busy },
      setOutput: (draft, output) => { draft.output = output },
      setError: (draft, error) => { draft.error = error },
      setNotRepo: (draft, notRepo) => { draft.notRepo = notRepo },
      setChangesHeight: (draft, height) => {
        draft.changesHeight = Math.min(MAX_CHANGES_HEIGHT, Math.max(MIN_CHANGES_HEIGHT, height))
      },
    },
  })
}
