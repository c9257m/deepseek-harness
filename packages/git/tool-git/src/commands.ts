/**
 * The git tool's model-facing command vocabulary: the typed request union
 * (mirrored 1:1 by the parameter schema in `index.ts`), per-command hand
 * validation of value constraints the schema DSL cannot express, and argv
 * construction. Every model-controlled value is a plain argv element — no
 * shell layer exists between the argv vector and git, so no quoting applies;
 * path arguments ride behind `--` so a leading-dash path can never parse as a
 * flag. The workdir and execution bounds stay with the caller.
 *
 * @module @deepseek-ai/dsh-tool-git/commands
 */

/** One accepted git operation. The `command` discriminant matches the schema's `request` union. */
export type GitRequest =
  | { command: 'status' }
  | { command: 'diff'; staged?: boolean; stat?: boolean; path?: string }
  | { command: 'log'; count?: number; path?: string }
  | { command: 'add'; paths: string[] }
  | { command: 'commit'; message: string; amend?: boolean }
  | { command: 'push'; remote?: string; branch?: string; setUpstream?: boolean }
  | { command: 'pull'; remote?: string; branch?: string; rebase?: boolean }
  | { command: 'merge'; ref: string; noFastForward?: boolean; fastForwardOnly?: boolean }
  | { command: 'branch'; create?: string; from?: string; delete?: string; deleteForce?: boolean }
  | { command: 'checkout'; branch?: string; createBranch?: string }
  | { command: 'restore'; paths: string[]; staged?: boolean }
  | { command: 'init'; branch?: string }

/** The schema-validated tool arguments (the schema's inferred type matches this). */
export interface GitToolArgs {
  /** Working directory the command runs in; defaults to the session workspace. */
  workdir?: string
  /** Cooperative deadline in milliseconds; defaults to the plugin config. */
  timeoutMs?: number
  /** The git operation to run. */
  request: GitRequest
}

/** A non-empty user-supplied value is required by a git operation. */
function requireNonEmpty(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string when given`)
  }
  return value
}

/**
 * Validate the value constraints the schema DSL cannot express. Returns the
 * accepted arguments unchanged (the schema already enforced types, required
 * keys, and the exact-one command union).
 * @param args - the schema-validated arguments.
 * @param maxLogCommits - the configured cap on one `log` request.
 * @returns the accepted arguments, unchanged.
 */
export function validateGitArgs(args: GitToolArgs, maxLogCommits: number): GitToolArgs {
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  const request = args.request
  switch (request.command) {
    case 'status':
      break
    case 'diff':
      if (request.path !== undefined) requireNonEmpty('path', request.path)
      break
    case 'log':
      if (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1 || request.count > maxLogCommits)) {
        throw new Error(`invalid count: expected an integer between 1 and ${maxLogCommits}, got ${JSON.stringify(request.count)}`)
      }
      if (request.path !== undefined) requireNonEmpty('path', request.path)
      break
    case 'add':
    case 'restore':
      if (request.paths.length === 0) throw new Error('invalid paths: expected at least one path')
      for (const path of request.paths) requireNonEmpty('path', path)
      break
    case 'commit':
      requireNonEmpty('message', request.message)
      break
    case 'push':
    case 'pull':
      if (request.remote !== undefined) requireNonEmpty('remote', request.remote)
      if (request.branch !== undefined) requireNonEmpty('branch', request.branch)
      break
    case 'merge':
      requireNonEmpty('ref', request.ref)
      if (request.noFastForward === true && request.fastForwardOnly === true) {
        throw new Error('invalid merge: noFastForward and fastForwardOnly are mutually exclusive')
      }
      break
    case 'branch': {
      if (request.create !== undefined && request.delete !== undefined) {
        throw new Error('invalid branch: create and delete are mutually exclusive')
      }
      if (request.create !== undefined) {
        requireNonEmpty('create', request.create)
        if (request.from !== undefined) requireNonEmpty('from', request.from)
        if (request.deleteForce === true) throw new Error('invalid branch: deleteForce requires delete')
      }
      if (request.delete !== undefined) {
        requireNonEmpty('delete', request.delete)
      }
      if (request.deleteForce === true && request.delete === undefined) {
        throw new Error('invalid branch: deleteForce requires delete')
      }
      break
    }
    case 'checkout': {
      const targets = [request.branch, request.createBranch].filter(name => name !== undefined && name.trim().length > 0)
      if (targets.length !== 1) {
        throw new Error('invalid checkout: exactly one of branch or createBranch is required')
      }
      break
    }
    case 'init':
      if (request.branch !== undefined) requireNonEmpty('branch', request.branch)
      break
    /* v8 ignore next 2 -- GitRequest is closed and every member is handled above */
    default:
      assertNever(request)
  }
  return args
}

/** Close the GitRequest union: an unhandled command is a schema/source drift. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(request: never): never {
  throw new Error(`unhandled git command ${JSON.stringify(request)}`)
}
/* v8 ignore stop */

/** The stable `log` record format the parser and argv share (see `parse.ts`). */
export const LOG_FORMAT = '%H%x00%h%x00%an%x00%aI%x00%s'

/** The stable `branch` listing format the parser and argv share (see `parse.ts`). */
export const BRANCH_FORMAT = '%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)'

/**
 * Build the git argv tail (everything after `git --no-pager`) for one
 * validated request. Pure in `request`: presentation reuses it for a readable
 * command line, and execution passes it to the spawn helper.
 * @param request - the validated operation.
 * @returns the argv tail (the subcommand first).
 */
export function buildGitArgv(request: GitRequest): string[] {
  switch (request.command) {
    case 'status':
      return ['status', '--porcelain=v1', '-b']
    case 'diff':
      return [
        'diff',
        ...request.staged === true ? ['--staged'] : [],
        ...request.stat === true ? ['--stat'] : [],
        ...request.path !== undefined ? ['--', request.path] : [],
      ]
    case 'log':
      return [
        'log',
        // Topological order keeps children before parents deterministically
        // (a merge shows its topic branch before the base) regardless of the
        // repo's commit-graph/date state.
        '--topo-order',
        `--format=${LOG_FORMAT}`,
        ...request.count !== undefined ? ['-n', String(request.count)] : [],
        ...request.path !== undefined ? ['--', request.path] : [],
      ]
    case 'add':
      return ['add', '--', ...request.paths]
    case 'commit':
      return ['commit', ...request.amend === true ? ['--amend'] : [], '-m', request.message]
    case 'push': {
      // `git push` positionals are `<repository> <refspec>`; a bare branch
      // would parse as the repository, so a branch without a remote defaults
      // to origin, and `--set-upstream` without a branch pushes HEAD (the
      // first-push idiom `git push -u origin HEAD`).
      const parts = ['push']
      if (request.setUpstream === true) parts.push('--set-upstream')
      if (request.remote !== undefined || request.branch !== undefined || request.setUpstream === true) {
        parts.push(request.remote ?? 'origin')
        if (request.branch !== undefined) parts.push(request.branch)
        else if (request.setUpstream === true) parts.push('HEAD')
      }
      return parts
    }
    case 'pull':
      return [
        'pull',
        ...request.rebase === true ? ['--rebase'] : [],
        ...request.remote !== undefined || request.branch !== undefined ? [request.remote ?? 'origin'] : [],
        ...request.branch !== undefined ? [request.branch] : [],
      ]
    case 'merge':
      return [
        'merge',
        ...request.noFastForward === true ? ['--no-ff'] : [],
        ...request.fastForwardOnly === true ? ['--ff-only'] : [],
        request.ref,
      ]
    case 'branch':
      if (request.create !== undefined) {
        return ['branch', request.create, ...request.from !== undefined ? [request.from] : []]
      }
      if (request.delete !== undefined) {
        return ['branch', request.deleteForce === true ? '-D' : '-d', request.delete]
      }
      return ['branch', `--format=${BRANCH_FORMAT}`]
    case 'checkout':
      if (request.createBranch !== undefined) return ['checkout', '-b', request.createBranch]
      /* v8 ignore next -- validation guarantees exactly one of branch/createBranch is present, so the empty fallback is dead */
      return ['checkout', request.branch ?? '']
    case 'restore':
      return ['restore', ...request.staged === true ? ['--staged'] : [], '--', ...request.paths]
    case 'init':
      return ['init', ...request.branch !== undefined ? ['-b', request.branch] : []]
    /* v8 ignore next 2 -- GitRequest is closed and every member is handled above */
    default:
      assertNever(request)
  }
}

/**
 * Which git operations need COMPLETE stdout (parsed), not a spillable tail.
 * @param request - the operation to classify.
 * @returns true when the operation's output is parsed (status/log/branch-list).
 */
export function parsesStdout(request: GitRequest): boolean {
  switch (request.command) {
    case 'status':
    case 'log':
    case 'branch':
      return true
    default:
      return false
  }
}
