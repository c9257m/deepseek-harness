/**
 * git domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { GitFileStatus } from './git.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** git.status request payload: the fully qualified workspace directory. */
export const gitStatusRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'git.status'>>>

/** One working-tree change (shared by the staged/unstaged buckets). */
export const gitFileStatusSchema = z.object({
  path: z.string(),
  status: z.string(),
  from: z.string().optional(),
}) satisfies z.ZodType<Wire<GitFileStatus>>

/** git.status response value. */
export const gitStatusValueSchema = z.object({
  status: z.object({
    branch: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    staged: z.array(gitFileStatusSchema),
    unstaged: z.array(gitFileStatusSchema),
    untracked: z.array(z.string()),
    conflicted: z.array(z.string()),
    clean: z.boolean(),
  }),
}) satisfies z.ZodType<Wire<ResponseValue<'git.status'>>>

/** git.commit request payload: the workspace directory and the commit message. */
export const gitCommitRequestSchema = z.object({
  path: z.string().min(1),
  message: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'git.commit'>>>

/** git.commit response value. */
export const gitCommitValueSchema = z.object({
  commit: z.object({
    hash: z.string(),
    shortHash: z.string(),
    subject: z.string(),
  }),
}) satisfies z.ZodType<Wire<ResponseValue<'git.commit'>>>

/** git.push / git.pull request payload: the workspace directory. */
export const gitPushPullRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'git.push'>>>

/** git.push / git.pull response value. */
export const gitOutputValueSchema = z.object({
  output: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'git.push'>>>

/** git.branches request payload: the workspace directory. */
export const gitBranchesRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'git.branches'>>>

/** git.branches response value. */
export const gitBranchesValueSchema = z.object({
  branches: z.array(z.object({
    name: z.string(),
    current: z.boolean(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    gone: z.boolean(),
  })),
}) satisfies z.ZodType<Wire<ResponseValue<'git.branches'>>>

/** git.checkout request payload: the workspace directory and the target branch. */
export const gitCheckoutRequestSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'git.checkout'>>>

/** git.checkout response value. */
export const gitCheckoutValueSchema = z.object({
  branch: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'git.checkout'>>>

/** git.stage / git.unstage request payload: the workspace directory and the paths to move. */
export const gitStageUnstageRequestSchema = z.object({
  path: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'git.stage'>>>

/** git.stage / git.unstage response value: the moved paths. */
export const gitFilesValueSchema = z.object({
  files: z.array(z.string()),
}) satisfies z.ZodType<Wire<ResponseValue<'git.stage'>>>

/** The wire error-code vocabulary shared by every git method. */
export type GitWireErrorCode =
  | 'git-not-a-repository'
  | 'git-failed'
  | 'git-aborted'
  | 'git-launch-failed'
  | 'git-output-overflow'

/**
 * Map one service GitError onto its stable wire error code.
 * @param code - the `GitError.code` from the service seam.
 * @returns the matching wire error code; unrecognized codes fall back to `git-failed`.
 */
export function gitErrorCode(code: string): GitWireErrorCode {
  switch (code) {
    case 'GIT_NOT_A_REPOSITORY':
      return 'git-not-a-repository'
    case 'GIT_ABORTED':
      return 'git-aborted'
    case 'GIT_LAUNCH_FAILED':
      return 'git-launch-failed'
    case 'GIT_OUTPUT_OVERFLOW':
      return 'git-output-overflow'
    default:
      return 'git-failed'
  }
}
