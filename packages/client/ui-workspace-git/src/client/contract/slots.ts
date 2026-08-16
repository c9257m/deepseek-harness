/**
 * ui-workspace-git contract: the panel fills the workspace file tree's
 * declared `sidebar.files.git` child hole, rendered beneath the tree. The
 * parent (ui-workspace-files' FileTree) decides where the hole renders and
 * passes no owner props; the panel derives the workspace path from the
 * standard sessions feed and calls the injected git wire methods.
 */
import type {
  GitBranchValue, GitCommitValue, GitOutputValue, GitStatusValue,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-workspace-files SlotMap merge (sidebar.files.git)
// into programs that resolve the runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-workspace-files/client'
import type { createGitPanelStore } from '../stores.ts'

/** Panel-private injected share: the git wire methods bound to the workspaces service. */
export interface GitPanelInjected {
  /** The working-tree picture of the workspace directory. */
  gitStatus: (path: string, signal?: AbortSignal) => Promise<GitStatusValue>
  /** Stage every change and commit it with the given message. */
  gitCommit: (path: string, message: string) => Promise<GitCommitValue>
  /** Stage the given workspace-relative paths into the index (`git add -- <paths>`). */
  gitStage: (path: string, files: readonly string[], signal?: AbortSignal) => Promise<string[]>
  /** Remove the given paths from the index, keeping working-tree content (`git restore --staged -- <paths>`). */
  gitUnstage: (path: string, files: readonly string[], signal?: AbortSignal) => Promise<string[]>
  /** Upload the current branch to its upstream remote. */
  gitPush: (path: string, signal?: AbortSignal) => Promise<GitOutputValue>
  /** Download and integrate the current branch from its upstream remote. */
  gitPull: (path: string, signal?: AbortSignal) => Promise<GitOutputValue>
  /** List the local branches of the workspace directory. */
  gitBranches: (path: string, signal?: AbortSignal) => Promise<GitBranchValue[]>
  /** Switch the workspace to an existing local branch. */
  gitCheckout: (path: string, branch: string) => Promise<string>
}

/** Full panel props: the runtime share + the shared store + injected actions + locale. */
export type GitPanelProps =
  PropsRuntime<'sidebar.files.git'>
  & PropsStore<ReturnType<typeof createGitPanelStore>>
  & GitPanelInjected
  & PropsLocale<'workspace-git'>
