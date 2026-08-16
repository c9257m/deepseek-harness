/**
 * git domain contract — the browser's quick git operations over a workspace
 * directory. Paths are always fully qualified host paths; the server runs the
 * system git binary in that directory. Errors carry the stable git codes
 * (`git-not-a-repository`, `git-failed`, `git-aborted`, `git-launch-failed`,
 * `git-output-overflow`). No protocol version: client and host ship together.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One working-tree change with its one-letter porcelain status. */
export interface GitFileStatus {
  /** The file path (the rename/copy target when `from` is present). */
  path: string
  /** The one-letter porcelain status: A/M/D/R/C/T/U. */
  status: string
  /** The rename/copy source path, when the entry is a rename or copy. */
  from?: string
}

/** The parsed working-tree picture one `git.status` call returns. */
export interface GitStatusValue {
  /** The current branch name, or null when detached. */
  branch: string | null
  /** The upstream branch, or null when the branch has none. */
  upstream: string | null
  /** Commits ahead of the upstream (0 when none or no upstream). */
  ahead: number
  /** Commits behind the upstream (0 when none or no upstream). */
  behind: number
  /** Changes staged in the index. */
  staged: GitFileStatus[]
  /** Changes in the working tree but not staged. */
  unstaged: GitFileStatus[]
  /** Untracked file paths. */
  untracked: string[]
  /** Paths with unresolved merge conflicts. */
  conflicted: string[]
  /** True when staged/unstaged/untracked/conflicted are all empty. */
  clean: boolean
}

/** The new commit identity one `git.commit` call returns. */
export interface GitCommitValue {
  /** Full 40-hex commit hash. */
  hash: string
  /** Short (7+) hash. */
  shortHash: string
  /** The commit subject (first line of the message). */
  subject: string
}

/** One parsed local branch. */
export interface GitBranchValue {
  /** The branch name. */
  name: string
  /** Whether this is the checked-out branch. */
  current: boolean
  /** The upstream branch, or null when none is configured. */
  upstream: string | null
  /** Commits ahead of the upstream (0 when none or no upstream). */
  ahead: number
  /** Commits behind the upstream (0 when none or no upstream). */
  behind: number
  /** True when the configured upstream no longer exists (`[gone]`). */
  gone: boolean
}

/** The retained git output of a push/pull. */
export interface GitOutputValue {
  /** Combined stdout and stderr text (git reports progress on either stream). */
  output: string
}

/** One record inside a unified-diff hunk (context, added, or deleted line). */
export interface GitDiffLine {
  /** The record class: unchanged context, added to the new file, or deleted from the old file. */
  type: 'context' | 'added' | 'deleted'
  /** The line text (without the diff prefix character). */
  text: string
}

/** One `@@` hunk of a unified diff with its old/new line ranges. */
export interface GitDiffHunk {
  /** First old-file line number (1-based). */
  oldStart: number
  /** Old-file line count (0 = the hunk covers no old lines, e.g. a pure addition). */
  oldCount: number
  /** First new-file line number (1-based). */
  newStart: number
  /** New-file line count (0 = the hunk covers no new lines, e.g. a pure deletion). */
  newCount: number
  /** The records in printed order. */
  lines: GitDiffLine[]
}

/** The parsed working-tree-vs-HEAD diff of one workspace file. */
export interface GitFileDiff {
  /** 'tracked' when the file has a git baseline; 'untracked' when every line is new (no baseline). */
  kind: 'tracked' | 'untracked'
  /** The parsed hunks (empty when clean or untracked). */
  hunks: GitDiffHunk[]
}

/** Host-level git operations over one workspace directory. */
export interface GitApi {
  /**
   * The working-tree picture of a workspace directory: branch, ahead/behind,
   * and the staged/unstaged/untracked/conflicted file buckets.
   */
  status(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ status: GitStatusValue }>>

  /**
   * The working-tree-vs-HEAD diff of one file inside the workspace, parsed
   * into hunks so the viewer can mark added and deleted lines. `git diff
   * HEAD` combines the staged and unstaged changes; an untracked file (or a
   * repo with no commits) yields `kind: 'untracked'` with empty hunks.
   */
  diff(
    request: RpcRequest<{ path: string; file: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ diff: GitFileDiff }>>

  /**
   * Stage every change and commit it with the given message — the GUI panel's
   * quick-commit semantics (unlike the model-facing tool's staged-only
   * commit). Returns the new commit's identity.
   */
  commit(
    request: RpcRequest<{ path: string; message: string }>,
  ): Promise<RpcResponse<{ commit: GitCommitValue }>>

  /**
   * Stage the given workspace-relative paths into the index (`git add -- <paths>`).
   */
  stage(
    request: RpcRequest<{ path: string; files: string[] }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ files: string[] }>>

  /**
   * Remove the given paths from the index, keeping working-tree content
   * (`git restore --staged -- <paths>`).
   */
  unstage(
    request: RpcRequest<{ path: string; files: string[] }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ files: string[] }>>

  /**
   * Upload the current branch to its upstream remote.
   */
  push(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<GitOutputValue>>

  /**
   * Download and integrate the current branch from its upstream remote.
   */
  pull(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<GitOutputValue>>

  /**
   * List the local branches of a workspace directory.
   */
  branches(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ branches: GitBranchValue[] }>>

  /**
   * Switch the workspace to an existing local branch.
   */
  checkout(
    request: RpcRequest<{ path: string; branch: string }>,
  ): Promise<RpcResponse<{ branch: string }>>
}
