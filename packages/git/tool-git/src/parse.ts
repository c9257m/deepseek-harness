/**
 * Pure parsers for the structured git outputs the tool returns to the model:
 * `git status --porcelain=v1 -b`, `git log --format=…`,
 * `git branch --format=…`, and the unified diff the GUI viewer turns into
 * per-line change marks (`parseFileDiff`). Each parser is a pure function of
 * the complete stdout the seam retained (PARSE commands fail with
 * `GIT_OUTPUT_OVERFLOW` before a parser ever sees truncated input), so a
 * malformed record is a contract violation and throws rather than silently
 * dropping data.
 *
 * @module @deepseek-ai/dsh-tool-git/parse
 */

/** One working-tree change with its one-letter porcelain status. */
export interface StatusFile {
  /** The file path (the rename/copy target when `from` is present). */
  path: string
  /** The one-letter porcelain status: A/M/D/R/C/T/U. */
  status: string
  /** The rename/copy source path, when the entry is a rename or copy. */
  from?: string
}

/** The parsed `git status --porcelain=v1 -b` working-tree picture. */
export interface StatusInfo {
  /** The current branch name, or null when detached (`HEAD (no branch)`). */
  branch: string | null
  /** The upstream branch, or null when the branch has none. */
  upstream: string | null
  /** Commits ahead of the upstream (0 when none or no upstream). */
  ahead: number
  /** Commits behind the upstream (0 when none or no upstream). */
  behind: number
  /** Changes staged in the index. */
  staged: StatusFile[]
  /** Changes in the working tree but not staged. */
  unstaged: StatusFile[]
  /** Untracked file paths. */
  untracked: string[]
  /** Paths with unresolved merge conflicts. */
  conflicted: string[]
}

/** One parsed commit from `git log`. */
export interface LogCommit {
  /** Full 40-hex commit hash. */
  hash: string
  /** Short (7+) hash. */
  shortHash: string
  /** Author name. */
  author: string
  /** Author date in strict ISO 8601 (e.g. `2026-08-15T09:30:00+08:00`). */
  date: string
  /** The commit subject (first line of the message). */
  subject: string
}

/** One parsed branch from `git branch --format=…`. */
export interface BranchInfo {
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

/** One record inside a unified-diff hunk (context, added, or deleted line). */
export interface DiffLine {
  /** The record class: unchanged context, added to the new file, or deleted from the old file. */
  type: 'context' | 'added' | 'deleted'
  /** The line text (without the diff prefix character). */
  text: string
}

/** One `@@` hunk of a unified diff with its old/new line ranges. */
export interface DiffHunk {
  /** First old-file line number (1-based). */
  oldStart: number
  /** Old-file line count (0 = the hunk covers no old lines, e.g. a pure addition). */
  oldCount: number
  /** First new-file line number (1-based). */
  newStart: number
  /** New-file line count (0 = the hunk covers no new lines, e.g. a pure deletion). */
  newCount: number
  /** The records in printed order. */
  lines: DiffLine[]
}

/** A malformed porcelain/format record — a git-version or format drift. */
function malformed(what: string, line: string): Error {
  return new Error(`could not parse git ${what} output: ${JSON.stringify(line)}`)
}

/** Parse the `[ahead N, behind M]` / `[gone]` track suffix into numeric facts. */
function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (track === '[gone]') return { ahead: 0, behind: 0, gone: true }
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return {
    ahead: ahead === null ? 0 : Number(requireGroup(ahead, 1, track)),
    behind: behind === null ? 0 : Number(requireGroup(behind, 1, track)),
    gone: false,
  }
}

/** One required regex capture group, or a malformed-record failure. */
function requireGroup(match: RegExpExecArray, index: number, source: string): string {
  const value = match[index]
  /* v8 ignore next -- every caller invokes requireGroup only after its regex matched, so the captured group always exists */
  if (value === undefined) throw malformed('status', source)
  return value
}

/**
 * Parse the `## …` branch line of `git status --porcelain=v1 -b` into the
 * branch, upstream, and ahead/behind facts.
 */
function parseStatusBranchLine(line: string): { branch: string | null; upstream: string | null; ahead: number; behind: number } {
  const rest = line.slice(3)
  if (rest === 'HEAD (no branch)' || rest.startsWith('HEAD (no branch) ')) {
    return { branch: null, upstream: null, ahead: 0, behind: 0 }
  }
  // An unborn branch (fresh repo, no commits) prints `No commits yet on <name>`.
  const unborn = 'No commits yet on '
  if (rest.startsWith(unborn)) {
    return { branch: rest.slice(unborn.length), upstream: null, ahead: 0, behind: 0 }
  }
  const separator = rest.indexOf('...')
  if (separator === -1) return { branch: rest, upstream: null, ahead: 0, behind: 0 }
  const branch = rest.slice(0, separator)
  const tail = rest.slice(separator + 3)
  const trackMatch = /^(.*?) \[(.*)\]$/.exec(tail)
  if (trackMatch === null) return { branch, upstream: tail, ahead: 0, behind: 0 }
  const upstream = requireGroup(trackMatch, 1, line)
  const track = requireGroup(trackMatch, 2, line)
  const facts = parseTrack(`[${track}]`)
  return { branch, upstream, ahead: facts.ahead, behind: facts.behind }
}

/** Parse a non-branch porcelain line into its two status letters and path facts. */
function parseStatusFileLine(line: string): { path: string; x: string; y: string; from?: string } {
  if (line.startsWith('?? ')) return { path: line.slice(3), x: '?', y: '?' }
  if (line.length < 4) throw malformed('status', line)
  const pathPart = line.slice(3)
  const arrow = pathPart.indexOf(' -> ')
  if (arrow !== -1) {
    return { path: pathPart.slice(arrow + 4), x: line.charAt(0), y: line.charAt(1), from: pathPart.slice(0, arrow) }
  }
  return { path: pathPart, x: line.charAt(0), y: line.charAt(1) }
}

/** Whether the two status letters describe an unresolved unmerged entry. */
function isUnmerged(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || x === 'A' && y === 'A' || x === 'D' && y === 'D'
}

/**
 * Parse complete `git status --porcelain=v1 -b` stdout into the working-tree
 * picture the tool returns. A rename/copy line contributes one entry under its
 * X letter (staged side) with its source in `from`; unmerged entries land only
 * in `conflicted`, never in the staged/unstaged buckets.
 * @param stdout - the complete porcelain output.
 * @returns the parsed status picture.
 */
export function parseStatus(stdout: string): StatusInfo {
  const info: StatusInfo = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  }
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('## ')) {
      Object.assign(info, parseStatusBranchLine(line))
      continue
    }
    const parsed = parseStatusFileLine(line)
    if (parsed.x === '?' && parsed.y === '?') {
      info.untracked.push(parsed.path)
      continue
    }
    if (isUnmerged(parsed.x, parsed.y)) {
      info.conflicted.push(parsed.path)
      continue
    }
    if (parsed.x !== ' ') {
      info.staged.push({ path: parsed.path, status: parsed.x, ...parsed.from !== undefined ? { from: parsed.from } : {} })
    }
    if (parsed.y !== ' ') {
      info.unstaged.push({ path: parsed.path, status: parsed.y, ...parsed.from !== undefined ? { from: parsed.from } : {} })
    }
  }
  return info
}

/**
 * Parse complete `git log --format=%H%x00%h%x00%an%x00%aI%x00%s` stdout into
 * commits, oldest-first as git printed them.
 * @param stdout - the complete log output.
 * @returns the parsed commits in printed order.
 */
export function parseLog(stdout: string): LogCommit[] {
  const commits: LogCommit[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const fields = line.split('\0')
    if (fields.length !== 5) throw malformed('log', line)
    const [hash, shortHash, author, date, subject] = fields
    /* v8 ignore next 2 -- the length check above already guarantees all five fields */
    if (hash === undefined || shortHash === undefined || author === undefined || date === undefined || subject === undefined) {
      throw malformed('log', line)
    }
    commits.push({ hash, shortHash, author, date, subject })
  }
  return commits
}

/**
 * Parse complete `git branch --format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)`
 * stdout into branches.
 * @param stdout - the complete branch listing.
 * @returns the parsed branches in printed order (the current branch is marked).
 */
export function parseBranches(stdout: string): BranchInfo[] {
  const branches: BranchInfo[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const fields = line.split('\0')
    if (fields.length !== 4) throw malformed('branch', line)
    const [name, head, upstream, track] = fields
    /* v8 ignore next 2 -- the length check above already guarantees all four fields */
    if (name === undefined || head === undefined || upstream === undefined || track === undefined) {
      throw malformed('branch', line)
    }
    const facts = parseTrack(track)
    branches.push({
      name,
      current: head === '*',
      upstream: upstream.length === 0 ? null : upstream,
      ahead: facts.ahead,
      behind: facts.behind,
      gone: facts.gone,
    })
  }
  return branches
}

/** The stable `@@ -a,b +c,d @@` hunk header, with the optional counts (`-a +c` means count 1). */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse the complete stdout of a single-file unified diff (the working tree
 * vs a baseline like HEAD for one path) into hunks. Metadata lines (`diff
 * --git`, `index`, `---`/`+++`, rename/mode lines, `Binary files … differ`,
 * and `\ No newline at end of file`) are skipped; a line that git could not
 * have produced — a record without a ` ` / `+` / `-` prefix inside a hunk, or
 * a hunk line outside any hunk — is a format drift and throws.
 * @param stdout - the complete diff output (empty for a clean or untracked file).
 * @returns the parsed hunks in printed order.
 */
export function parseFileDiff(stdout: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('@@ ')) {
      const match = HUNK_HEADER.exec(line)
      if (match === null) throw malformed('diff', line)
      current = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current !== undefined) {
      // A line inside a hunk must be a record (` `, `+`, or `-` prefix) or
      // the no-newline marker; anything else is a git version or format drift.
      const prefix = line.charAt(0)
      if (prefix === ' ' || prefix === '+' || prefix === '-') {
        current.lines.push({
          type: prefix === ' ' ? 'context' : prefix === '+' ? 'added' : 'deleted',
          text: line.slice(1),
        })
        continue
      }
      if (line.startsWith('\\ ')) continue
      throw malformed('diff', line)
    }
    // Outside a hunk only metadata lines are legitimate.
    continue
  }
  return hunks
}
