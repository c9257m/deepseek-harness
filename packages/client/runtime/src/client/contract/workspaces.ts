/**
 * The outward workspaces-service face — what `ctx.workspaces` exposes to
 * feature packages and the renderer host, and therefore exactly what the
 * test runtime's workspaces double must implement. Wire-pump entry points
 * (handleHostEnvelope/handleConnected/refresh/startInitialSelection) stay on
 * the concrete class. Widening this interface is the explicit act of
 * widening what features may do to the workspaces domain.
 */
import type {
  DirectoryListing, GitBranchValue, GitCommitValue, GitFileDiff, GitOutputValue, GitStatusValue,
  SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '../workspaces/service.ts'
import type { ObservableSnapshot } from './store.ts'

/** The workspaces-service face injected as `ctx.workspaces`. */
export interface IWorkspaces {
  /** The useWorkspaces standard feed (read face — writes stay inside the domain). */
  readonly list: ObservableSnapshot<WorkspaceListState>
  /**
   * Connect a Workspace to its reusable or freshly created blank session.
   * @param workspaceId - target workspace.
   * @returns the connected session id.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * The New Session flow: connect the explicit, current-Session, or recent
   * Workspace and open the resulting session; failures surface on the session
   * list state.
   * @param workspaceId - explicit target; omitted inherits the current
   * Session's Workspace before falling back to the recency projection.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Register an existing path as a Workspace.
   * @param input - the Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  create(input: { path: string }): Promise<WorkspaceView>
  /**
   * Open the Host's native directory picker.
   * @returns the selected path, or null when the user cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one directory level through the Host's `browse` capability.
   * @param path - absolute directory to list; absent lists the Host home directory.
   * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
   * @returns the level's listing with breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create one child directory through the Host's `browse` capability.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment.
   * @returns the created directory's absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * Read a regular text file through the Host's `browse` capability.
   * @param path - absolute file path.
   * @param signal - aborts the wire request (and the Host's read) when the caller supersedes it.
   * @returns the decoded text content of the whole file (bounded by the Host's byte cap).
   */
  readFile(path: string, signal?: AbortSignal): Promise<string>
  /**
   * Replace a text file's whole content atomically through the Host's
   * `browse` capability.
   * @param path - absolute file path.
   * @param content - the complete next file content.
   * @returns resolution after the Host's atomic replacement.
   */
  writeFile(path: string, content: string): Promise<void>
  /**
   * Open a filesystem path with the Host operating system's default application.
   * @param path - absolute or host-resolvable path.
   */
  openPath(path: string): Promise<void>
  /**
   * The working-tree picture of a workspace directory (branch, ahead/behind,
   * and the staged/unstaged/untracked/conflicted file buckets).
   * @param path - absolute workspace directory.
   * @param signal - aborts the wire request (and the Host's git run) when the caller supersedes it.
   */
  gitStatus(path: string, signal?: AbortSignal): Promise<GitStatusValue>
  /**
   * The working-tree-vs-HEAD diff of one file inside the workspace, parsed
   * into hunks so the viewer can mark added and deleted lines. `git diff
   * HEAD` combines the staged and unstaged changes; an untracked file (or a
   * repo with no commits) yields `kind: 'untracked'` with empty hunks.
   * @param path - absolute workspace directory.
   * @param file - workspace-relative or absolute file path inside `path`.
   * @param signal - aborts the wire request (and the Host's git run) when the caller supersedes it.
   */
  gitDiff(path: string, file: string, signal?: AbortSignal): Promise<GitFileDiff>
  /**
   * Stage every change and commit it with the given message (the panel's
   * quick-commit semantics) and return the new commit's identity.
   * @param path - absolute workspace directory.
   * @param message - the commit message (subject line).
   */
  gitCommit(path: string, message: string): Promise<GitCommitValue>
  /**
   * Stage the given workspace-relative paths into the index (`git add -- <paths>`).
   * @param path - absolute workspace directory.
   * @param files - workspace-relative paths to stage (as `gitStatus` reports them).
   * @param signal - aborts the wire request (and the Host's git run) when the caller supersedes it.
   * @returns the staged paths.
   */
  gitStage(path: string, files: readonly string[], signal?: AbortSignal): Promise<string[]>
  /**
   * Remove the given paths from the index, keeping working-tree content
   * (`git restore --staged -- <paths>`).
   * @param path - absolute workspace directory.
   * @param files - workspace-relative paths to unstage.
   * @param signal - aborts the wire request (and the Host's git run) when the caller supersedes it.
   * @returns the unstaged paths.
   */
  gitUnstage(path: string, files: readonly string[], signal?: AbortSignal): Promise<string[]>
  /**
   * Upload the current branch to its upstream remote.
   * @param path - absolute workspace directory.
   * @param signal - aborts the wire request (and the Host's git run) when the caller supersedes it.
   */
  gitPush(path: string, signal?: AbortSignal): Promise<GitOutputValue>
  /**
   * Download and integrate the current branch from its upstream remote.
   * @param path - absolute workspace directory.
   * @param signal - aborts the wire request (and the Host's git run) when the caller supersedes it.
   */
  gitPull(path: string, signal?: AbortSignal): Promise<GitOutputValue>
  /**
   * List the local branches of a workspace directory.
   * @param path - absolute workspace directory.
   * @param signal - aborts the wire request (and the Host's git run) when the caller supersedes it.
   */
  gitBranches(path: string, signal?: AbortSignal): Promise<GitBranchValue[]>
  /**
   * Switch the workspace to an existing local branch.
   * @param path - absolute workspace directory.
   * @param branch - the branch to check out.
   */
  gitCheckout(path: string, branch: string): Promise<string>
  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - the new display title.
   * @returns the updated Workspace view.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * Delete a Workspace (its sessions fall back to the unaccounted group).
   * @param workspaceId - target workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * Move a Workspace within the registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * Move an accounted session within/into a Workspace's ordered list.
   * @param workspaceId - target workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView>
  /**
   * Archive a session into the registry-global set (hidden from grouping
   * surfaces; session log and accounting slot remain). Archiving the current
   * session clears the selection into the New Session view state.
   * @param sessionId - session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
}
