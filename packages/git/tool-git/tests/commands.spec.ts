/**
 * Pure unit tests for the git tool's command builders, argument validation,
 * and output parsers — no subprocess service involved. The fake-service suite
 * (tools.spec.ts) covers the execution path; the real-git suite
 * (integration.spec.ts) pins the world against the actual binary.
 */

import { describe, expect, it } from 'vitest'
import {
  buildGitArgv,
  validateGitArgs,
} from '@deepseek-ai/dsh-tool-git'
import type { GitRequest, GitToolArgs } from '@deepseek-ai/dsh-tool-git'
import {
  parseBranches,
  parseFileDiff,
  parseLog,
  parseStatus,
} from '@deepseek-ai/dsh-tool-git'

const MAX_LOG = 50

/** A valid base args object; each test overrides the request it exercises. */
function args(request: GitRequest): GitToolArgs {
  return { request }
}

describe('buildGitArgv', () => {
  it('builds the porcelain status request', () => {
    expect(buildGitArgv({ command: 'status' })).toEqual(['status', '--porcelain=v1', '-b'])
  })

  it('builds a plain, staged, stat, and path-scoped diff', () => {
    expect(buildGitArgv({ command: 'diff' })).toEqual(['diff'])
    expect(buildGitArgv({ command: 'diff', staged: true })).toEqual(['diff', '--staged'])
    expect(buildGitArgv({ command: 'diff', stat: true })).toEqual(['diff', '--stat'])
    expect(buildGitArgv({ command: 'diff', path: 'src/a.ts' })).toEqual(['diff', '--', 'src/a.ts'])
    expect(buildGitArgv({ command: 'diff', staged: true, path: '-weird.ts' })).toEqual(['diff', '--staged', '--', '-weird.ts'])
  })

  it('builds a bounded log with a path after the terminator', () => {
    expect(buildGitArgv({ command: 'log' })).toEqual(['log', '--topo-order', '--format=%H%x00%h%x00%an%x00%aI%x00%s'])
    expect(buildGitArgv({ command: 'log', count: 5, path: 'README.md' }))
      .toEqual(['log', '--topo-order', '--format=%H%x00%h%x00%an%x00%aI%x00%s', '-n', '5', '--', 'README.md'])
  })

  it('passes add paths behind the terminator without quoting', () => {
    expect(buildGitArgv({ command: 'add', paths: ['.'] })).toEqual(['add', '--', '.'])
    expect(buildGitArgv({ command: 'add', paths: ['src', 'weird name.ts'] }))
      .toEqual(['add', '--', 'src', 'weird name.ts'])
  })

  it('builds a commit with a literal message and the amend flag', () => {
    expect(buildGitArgv({ command: 'commit', message: 'fix: the bug' }))
      .toEqual(['commit', '-m', 'fix: the bug'])
    expect(buildGitArgv({ command: 'commit', message: 'fix', amend: true }))
      .toEqual(['commit', '--amend', '-m', 'fix'])
  })

  it('builds push/pull with option flags and positional remote/branch', () => {
    expect(buildGitArgv({ command: 'push' })).toEqual(['push'])
    expect(buildGitArgv({ command: 'push', remote: 'origin', branch: 'main', setUpstream: true }))
      .toEqual(['push', '--set-upstream', 'origin', 'main'])
    expect(buildGitArgv({ command: 'push', setUpstream: true }))
      .toEqual(['push', '--set-upstream', 'origin', 'HEAD'])
    expect(buildGitArgv({ command: 'push', remote: 'origin' }))
      .toEqual(['push', 'origin'])
    expect(buildGitArgv({ command: 'push', branch: 'main' }))
      .toEqual(['push', 'origin', 'main'])
    expect(buildGitArgv({ command: 'pull', rebase: true })).toEqual(['pull', '--rebase'])
    expect(buildGitArgv({ command: 'pull', remote: 'origin', branch: 'main' }))
      .toEqual(['pull', 'origin', 'main'])
    expect(buildGitArgv({ command: 'pull', branch: 'main' }))
      .toEqual(['pull', 'origin', 'main'])
  })

  it('builds merge with the requested strategy flags', () => {
    expect(buildGitArgv({ command: 'merge', ref: 'feature' })).toEqual(['merge', 'feature'])
    expect(buildGitArgv({ command: 'merge', ref: 'feature', noFastForward: true }))
      .toEqual(['merge', '--no-ff', 'feature'])
    expect(buildGitArgv({ command: 'merge', ref: 'feature', fastForwardOnly: true }))
      .toEqual(['merge', '--ff-only', 'feature'])
  })

  it('builds branch list, create, and delete forms', () => {
    expect(buildGitArgv({ command: 'branch' }))
      .toEqual(['branch', '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)'])
    expect(buildGitArgv({ command: 'branch', create: 'topic', from: 'main' }))
      .toEqual(['branch', 'topic', 'main'])
    expect(buildGitArgv({ command: 'branch', delete: 'topic' }))
      .toEqual(['branch', '-d', 'topic'])
    expect(buildGitArgv({ command: 'branch', delete: 'topic', deleteForce: true }))
      .toEqual(['branch', '-D', 'topic'])
  })

  it('builds checkout switch/create and restore forms', () => {
    expect(buildGitArgv({ command: 'checkout', branch: 'main' })).toEqual(['checkout', 'main'])
    expect(buildGitArgv({ command: 'checkout', createBranch: 'topic' })).toEqual(['checkout', '-b', 'topic'])
    expect(buildGitArgv({ command: 'restore', paths: ['src'] })).toEqual(['restore', '--', 'src'])
    expect(buildGitArgv({ command: 'restore', paths: ['a.ts'], staged: true })).toEqual(['restore', '--staged', '--', 'a.ts'])
  })

  it('builds init with an optional initial branch', () => {
    expect(buildGitArgv({ command: 'init' })).toEqual(['init'])
    expect(buildGitArgv({ command: 'init', branch: 'trunk' })).toEqual(['init', '-b', 'trunk'])
  })
})

describe('validateGitArgs', () => {
  it('accepts every command with valid values', () => {
    const cases: GitRequest[] = [
      { command: 'status' },
      { command: 'diff', staged: true, path: 'a' },
      { command: 'log', count: 10, path: 'a' },
      { command: 'add', paths: ['a', 'b'] },
      { command: 'commit', message: 'msg' },
      { command: 'push', remote: 'origin' },
      { command: 'push', branch: 'main' },
      { command: 'pull', rebase: true },
      { command: 'pull', branch: 'main' },
      { command: 'merge', ref: 'main' },
      { command: 'branch' },
      { command: 'branch', create: 'x', from: 'main' },
      { command: 'branch', delete: 'x' },
      { command: 'branch', delete: 'x', deleteForce: true },
      { command: 'checkout', branch: 'main' },
      { command: 'checkout', createBranch: 'x' },
      { command: 'restore', paths: ['a'] },
      { command: 'init', branch: 'trunk' },
      { command: 'init' },
    ]
    for (const request of cases) {
      expect(() => validateGitArgs(args(request), MAX_LOG)).not.toThrow()
    }
  })

  it('rejects a non-positive or non-finite timeoutMs', () => {
    expect(() => validateGitArgs({ request: { command: 'status' }, timeoutMs: 0 }, MAX_LOG)).toThrow(/timeoutMs/)
    expect(() => validateGitArgs({ request: { command: 'status' }, timeoutMs: -5 }, MAX_LOG)).toThrow(/timeoutMs/)
    expect(() => validateGitArgs({ request: { command: 'status' }, timeoutMs: Number.NaN }, MAX_LOG)).toThrow(/timeoutMs/)
  })

  it('rejects a blank commit message and a count beyond the cap', () => {
    expect(() => validateGitArgs(args({ command: 'commit', message: '   ' }), MAX_LOG)).toThrow(/message/)
    expect(() => validateGitArgs(args({ command: 'log', count: 0 }), MAX_LOG)).toThrow(/count/)
    expect(() => validateGitArgs(args({ command: 'log', count: 1.5 }), MAX_LOG)).toThrow(/count/)
    expect(() => validateGitArgs(args({ command: 'log', count: MAX_LOG + 1 }), MAX_LOG)).toThrow(/count/)
  })

  it('rejects an empty paths list and blank paths', () => {
    expect(() => validateGitArgs(args({ command: 'add', paths: [] }), MAX_LOG)).toThrow(/paths/)
    expect(() => validateGitArgs(args({ command: 'add', paths: [' '] }), MAX_LOG)).toThrow(/path/)
    expect(() => validateGitArgs(args({ command: 'restore', paths: [] }), MAX_LOG)).toThrow(/paths/)
  })

  it('rejects conflicting merge and branch option combinations', () => {
    expect(() => validateGitArgs(args({ command: 'merge', ref: 'x', noFastForward: true, fastForwardOnly: true }), MAX_LOG))
      .toThrow(/mutually exclusive/)
    expect(() => validateGitArgs(args({ command: 'branch', create: 'x', delete: 'y' }), MAX_LOG)).toThrow(/mutually exclusive/)
    expect(() => validateGitArgs(args({ command: 'branch', deleteForce: true }), MAX_LOG)).toThrow(/deleteForce requires delete/)
    expect(() => validateGitArgs(args({ command: 'branch', create: 'x', deleteForce: true }), MAX_LOG)).toThrow(/deleteForce requires delete/)
  })

  it('requires exactly one checkout target', () => {
    expect(() => validateGitArgs(args({ command: 'checkout' }), MAX_LOG)).toThrow(/exactly one/)
    expect(() => validateGitArgs(args({ command: 'checkout', branch: 'a', createBranch: 'b' }), MAX_LOG)).toThrow(/exactly one/)
  })

  it('rejects blank optional strings', () => {
    expect(() => validateGitArgs(args({ command: 'diff', path: ' ' }), MAX_LOG)).toThrow(/path/)
    expect(() => validateGitArgs(args({ command: 'init', branch: ' ' }), MAX_LOG)).toThrow(/branch/)
    expect(() => validateGitArgs(args({ command: 'push', remote: ' ' }), MAX_LOG)).toThrow(/remote/)
    expect(() => validateGitArgs(args({ command: 'push', branch: ' ' }), MAX_LOG)).toThrow(/branch/)
    expect(() => validateGitArgs(args({ command: 'pull', branch: ' ' }), MAX_LOG)).toThrow(/branch/)
  })
})

describe('parseStatus', () => {
  it('parses a clean tree with branch and upstream tracking', () => {
    const info = parseStatus('## main...origin/main [ahead 2, behind 1]\n')
    expect(info.branch).toBe('main')
    expect(info.upstream).toBe('origin/main')
    expect(info.ahead).toBe(2)
    expect(info.behind).toBe(1)
    expect(info.staged).toEqual([])
    expect(info.unstaged).toEqual([])
    expect(info.untracked).toEqual([])
    expect(info.conflicted).toEqual([])
  })

  it('parses staged, unstaged, untracked, and conflicted entries', () => {
    const info = parseStatus([
      '## main',
      'M  src/a.ts',
      ' M src/b.ts',
      'MM src/c.ts',
      'A  src/new.ts',
      'D  src/old.ts',
      '?? notes.md',
      'UU conflict.txt',
      'AA both-added.txt',
    ].join('\n') + '\n')
    expect(info.branch).toBe('main')
    expect(info.staged.map(e => [e.path, e.status])).toEqual([
      ['src/a.ts', 'M'],
      ['src/c.ts', 'M'],
      ['src/new.ts', 'A'],
      ['src/old.ts', 'D'],
    ])
    expect(info.unstaged.map(e => [e.path, e.status])).toEqual([
      ['src/b.ts', 'M'],
      ['src/c.ts', 'M'],
    ])
    expect(info.untracked).toEqual(['notes.md'])
    expect(info.conflicted).toEqual(['conflict.txt', 'both-added.txt'])
  })

  it('parses a rename with its source', () => {
    const info = parseStatus('## main\nR  old.ts -> new.ts\n')
    expect(info.staged).toEqual([{ path: 'new.ts', status: 'R', from: 'old.ts' }])
    expect(info.unstaged).toEqual([])
  })

  it('parses an unstaged rename with its source', () => {
    const info = parseStatus('## main\n M a.txt -> b.txt\n')
    expect(info.unstaged).toEqual([{ path: 'b.txt', status: 'M', from: 'a.txt' }])
    expect(info.staged).toEqual([])
  })

  it('reports a detached HEAD and a gone upstream', () => {
    expect(parseStatus('## HEAD (no branch)\n').branch).toBeNull()
    const gone = parseStatus('## main...origin/main [gone]\n')
    expect(gone.upstream).toBe('origin/main')
    expect(gone.ahead).toBe(0)
    expect(gone.behind).toBe(0)
  })

  it('rejects a malformed porcelain line', () => {
    expect(() => parseStatus('## main\nX\n')).toThrow(/could not parse git status/)
  })
})

describe('parseLog', () => {
  it('parses one commit per NUL-separated record', () => {
    const commits = parseLog('abc1234abc1234abc1234abc1234abc1234\u0000abc1234\u0000Alice\u00002026-08-15T09:30:00+08:00\u0000Add feature\n')
    expect(commits).toEqual([{
      hash: 'abc1234abc1234abc1234abc1234abc1234',
      shortHash: 'abc1234',
      author: 'Alice',
      date: '2026-08-15T09:30:00+08:00',
      subject: 'Add feature',
    }])
  })

  it('returns no commits for empty output', () => {
    expect(parseLog('')).toEqual([])
  })

  it('rejects a malformed record', () => {
    expect(() => parseLog('only-a-hash\n')).toThrow(/could not parse git log/)
  })
})

describe('parseBranches', () => {
  it('parses the listing with current/upstream/tracking facts', () => {
    const branches = parseBranches([
      'main\0\0origin/main\0[ahead 1, behind 2]',
      'topic\0*\0\0',
      'old\0\0origin/old\0[gone]',
    ].join('\n') + '\n')
    expect(branches).toEqual([
      { name: 'main', current: false, upstream: 'origin/main', ahead: 1, behind: 2, gone: false },
      { name: 'topic', current: true, upstream: null, ahead: 0, behind: 0, gone: false },
      { name: 'old', current: false, upstream: 'origin/old', ahead: 0, behind: 0, gone: true },
    ])
  })

  it('rejects a malformed record', () => {
    expect(() => parseBranches('main\0\n')).toThrow(/could not parse git branch/)
  })
})

describe('parseFileDiff', () => {
  const FULL = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' keep',
    '-drop this line',
    '+added line',
    ' keep',
  ].join('\n') + '\n'

  it('parses a full single-file diff into hunks with line records', () => {
    expect(parseFileDiff(FULL)).toEqual([{
      oldStart: 1, oldCount: 3, newStart: 1, newCount: 4,
      lines: [
        { type: 'context', text: 'keep' },
        { type: 'deleted', text: 'drop this line' },
        { type: 'added', text: 'added line' },
        { type: 'context', text: 'keep' },
      ],
    }])
  })

  it('parses the shorthand hunk counts (a missing ,count means 1)', () => {
    const hunks = parseFileDiff('@@ -5 +6 @@\n context\n')
    expect(hunks).toEqual([{ oldStart: 5, oldCount: 1, newStart: 6, newCount: 1, lines: [{ type: 'context', text: 'context' }] }])
  })

  it('parses multiple hunks with a pure-deletion hunk (newCount 0)', () => {
    const hunks = parseFileDiff([
      '@@ -1,2 +1,1 @@',
      ' a',
      '-b',
      '@@ -10,2 +9,0 @@',
      '-c',
      '-d',
    ].join('\n') + '\n')
    expect(hunks).toEqual([
      { oldStart: 1, oldCount: 2, newStart: 1, newCount: 1, lines: [
        { type: 'context', text: 'a' },
        { type: 'deleted', text: 'b' },
      ] },
      { oldStart: 10, oldCount: 2, newStart: 9, newCount: 0, lines: [
        { type: 'deleted', text: 'c' },
        { type: 'deleted', text: 'd' },
      ] },
    ])
  })

  it('skips rename and mode metadata lines and the no-newline marker', () => {
    const hunks = parseFileDiff([
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
      'index 1111111..2222222 100644',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-old content',
      '+new content',
      '\\ No newline at end of file',
    ].join('\n') + '\n')
    expect(hunks).toEqual([{
      oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
      lines: [
        { type: 'deleted', text: 'old content' },
        { type: 'added', text: 'new content' },
      ],
    }])
  })

  it('returns no hunks for empty output, binary diffs, and mode-only changes', () => {
    expect(parseFileDiff('')).toEqual([])
    expect(parseFileDiff('Binary files a/x.bin and b/x.bin differ\n')).toEqual([])
    expect(parseFileDiff([
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n') + '\n')).toEqual([])
  })

  it('rejects a malformed hunk header and a record outside a hunk', () => {
    expect(() => parseFileDiff('@@ -nope @@\n')).toThrow(/could not parse git diff/)
    expect(() => parseFileDiff('@@ -1 +1 @@\nbroken record\n')).toThrow(/could not parse git diff/)
  })
})
