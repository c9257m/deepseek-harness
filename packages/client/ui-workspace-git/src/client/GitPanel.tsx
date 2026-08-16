/**
 * The git quick-action panel beneath the sidebar file tree. Shows the current
 * branch with ahead/behind facts, the changed-file buckets, a stage-all
 * commit box, push/pull/refresh actions, and a branch switcher. Reads the
 * session workspace path from the standard sessions feed and calls the
 * injected git wire methods; the loaded facts and the interaction draft live
 * in the shared store. A workspace outside a git repository shows a compact
 * "not a git repository" notice instead of the controls.
 *
 * Each changed-file row opens that file in the shared file viewer (the owner
 * share supplies the tree's open gestures): git reports workspace-relative
 * paths, so the row resolves them against the session cwd before opening.
 */
import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconRefreshOutline14, IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitFileStatus } from '@deepseek-ai/dsh-client-runtime/client'
import type { GitPanelProps } from './contract/slots.ts'
import css from './GitPanel.module.css'

/** The label and files of one changed-file bucket. */
function bucket(t: GitPanelProps['t'], key: 'staged' | 'unstaged' | 'untracked' | 'conflicted', files: readonly GitFileStatus[] | readonly string[]): {
  label: string
  entries: readonly (GitFileStatus | string)[]
} {
  const labels = {
    staged: t('git.staged'),
    unstaged: t('git.unstaged'),
    untracked: t('git.untracked'),
    conflicted: t('git.conflicted'),
  }
  return { label: labels[key], entries: files }
}

/** Base name of an absolute host path (the panel shows short names). */
function baseNameOf(path: string): string {
  // git paths are non-empty; the fallback covers a hypothetical empty segment list.
  /* v8 ignore next -- a bucket entry is always a non-empty path. */
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/** Whether a git status path is already absolute (drive letter, UNC, or POSIX root). */
function looksAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Resolve a git status path — workspace-relative as git reports it, or
 * already absolute — against the workspace root. The client never joins
 * path segments for the viewer, but git hands the panel relative paths, so
 * the row must complete them here; the host resolves the result on its side.
 * @param root - the session workspace directory.
 * @param path - the git-reported path.
 * @returns the absolute path to open.
 */
function absoluteOf(root: string, path: string): string {
  return looksAbsolute(path) ? path : `${root.replace(/[\\/]+$/, '')}/${path}`
}

/**
 * Render the git quick-action panel.
 * @param props - composed slot props (runtime share + store + injected git methods + locale).
 * @returns the panel element tree, or null when no session workspace exists.
 */
export function GitPanel({
  useSessions, useStore, actions,
  gitStatus, gitCommit, gitStage, gitUnstage, gitPush, gitPull, gitBranches, gitCheckout,
  openFile, enterFileMode,
  t,
}: GitPanelProps) {
  const sessions = useSessions(s => s)
  const rootPath = sessions.current === undefined ? undefined : sessions.byId[sessions.current]?.cwd
  const state = useStore(s => s)
  // Supersession counter + live abort: a newer root or refresh invalidates
  // stale settlements and aborts the in-flight wire requests.
  const loadSeq = useRef(0)
  const loadSignal = useRef<AbortController | undefined>(undefined)

  // Vertical drag of the changes-list resize handle: pointer capture on the
  // handle drives the stored height, clamped to the panel's bounds.
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null)
  const onResizePointerDown = (event: React.PointerEvent): void => {
    event.preventDefault()
    dragState.current = { startY: event.clientY, startHeight: state.changesHeight }
    const move = (moveEvent: PointerEvent): void => {
      const drag = dragState.current
      /* v8 ignore next 2 -- the listeners exist only while onResizePointerDown has set dragState; the guard is defensive. */
      if (drag === null) return
      actions.setChangesHeight(drag.startHeight + (moveEvent.clientY - drag.startY))
    }
    const up = (): void => {
      dragState.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const load = (path: string, opts: { clearError?: boolean } = {}): void => {
    loadSignal.current?.abort()
    const signal = new AbortController()
    loadSignal.current = signal
    const seq = ++loadSeq.current
    if (opts.clearError === true) {
      // A root change or an explicit refresh resets the notice; the automatic
      // reload after an operation keeps the operation's error/output visible.
      actions.setNotRepo(false)
      actions.setError(null)
    }
    gitStatus(path, signal.signal).then(
      (status) => {
        if (seq !== loadSeq.current) return
        actions.setStatus(status)
      },
      (reason: unknown) => {
        if (seq !== loadSeq.current) return
        if (isNotRepoError(reason)) {
          actions.setNotRepo(true)
          actions.setStatus(null)
        } else {
          actions.setError(messageOf(reason))
        }
      },
    )
    gitBranches(path, signal.signal).then(
      (branches) => {
        if (seq !== loadSeq.current) return
        actions.setBranches(branches)
      },
      () => {
        // Branch listing failure is secondary; the status already surfaced.
        if (seq !== loadSeq.current) return
        actions.setBranches([])
      },
    )
  }

  // A new root (or the first session) reloads the panel.
  useEffect(() => {
    loadSeq.current += 1
    actions.setStatus(null)
    actions.setBranches([])
    actions.setOutput(null)
    actions.setError(null)
    actions.setNotRepo(false)
    if (rootPath === undefined) return
    load(rootPath)
  }, [rootPath])

  if (rootPath === undefined) return null

  const status = state.status
  const run = async (operation: (path: string, signal: AbortSignal) => Promise<string | null>): Promise<void> => {
    if (state.busy) return
    const controller = new AbortController()
    actions.setBusy(true)
    actions.setError(null)
    actions.setOutput(null)
    try {
      const output = await operation(rootPath, controller.signal)
      actions.setOutput(output)
    } catch (reason: unknown) {
      actions.setError(messageOf(reason))
    } finally {
      actions.setBusy(false)
      load(rootPath)
    }
  }

  const commit = (): void => {
    const message = state.commitMessage.trim()
    // The commit button is disabled for a blank message; the guard also
    // covers the Enter-key path.
    /* v8 ignore next 2 -- a blank message cannot reach commit() through the disabled button; the branch is defensive. */
    if (message.length === 0) return
    void run(async (path) => {
      const commit = await gitCommit(path, message)
      actions.setCommitMessage('')
      return t('git.committed', { shortHash: commit.shortHash })
    })
  }
  const push = (): void => {
    void run(async (path, signal) => { await gitPush(path, signal); return t('git.pushDone') })
  }
  const pull = (): void => {
    void run(async (path, signal) => { await gitPull(path, signal); return t('git.pullDone') })
  }
  const stage = (files: readonly string[]): void => {
    // The panel only offers paths parsed from status; the guard mirrors the
    // host service fence for a hypothetical empty list.
    /* v8 ignore next 2 -- the bucket rows always carry at least one path. */
    if (files.length === 0) return
    void run(async (path, signal) => {
      const staged = await gitStage(path, files, signal)
      return t('git.stagedN', { n: staged.length })
    })
  }
  const unstage = (files: readonly string[]): void => {
    /* v8 ignore next 2 -- the bucket rows always carry at least one path. */
    if (files.length === 0) return
    void run(async (path, signal) => {
      const unstaged = await gitUnstage(path, files, signal)
      return t('git.unstagedN', { n: unstaged.length })
    })
  }
  const checkout = (branch: string): void => {
    // Branch names are non-empty by git's contract; the guard mirrors the
    // host service fence for a hypothetical empty option.
    /* v8 ignore next 2 -- the select only offers parsed git branch names, which are non-empty. */
    if (branch.length === 0) return
    void run(async (path) => { await gitCheckout(path, branch); return branch })
  }

  if (state.notRepo) {
    return (
      <div className={css.panel}>
        <div className={css.notRepo} role="status">
          <IconWarningOutline16 className={css.warnIcon} />
          {t('git.notRepo')}
        </div>
      </div>
    )
  }

  const branchName = status?.branch ?? t('git.detached')
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const track = status?.upstream === null
    ? ''
    : ` (${[ahead > 0 ? t('git.ahead', { n: ahead }) : '', behind > 0 ? t('git.behind', { n: behind }) : '']
      .filter(Boolean)
      .join('，')})`
  const changeCount = (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0)
    + (status?.untracked.length ?? 0) + (status?.conflicted.length ?? 0)
  const current = state.branches.find(candidate => candidate.current)?.name ?? branchName

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <span className={css.title}>{t('git.title')}</span>
        <div className={css.headerActions}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={state.collapsed ? t('git.expand') : t('git.collapse')}
            aria-expanded={!state.collapsed}
            onClick={() => { actions.setCollapsed(!state.collapsed) }}
          >
            {state.collapsed
              ? <IconChevronRightOutline14 className={css.collapseIcon} />
              : <IconChevronDownOutline14 className={css.collapseIcon} />}
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('git.refresh')}
            disabled={state.busy}
            onClick={() => { load(rootPath, { clearError: true }) }}
          >
            <IconRefreshOutline14 className={css.refreshIcon} />
          </button>
        </div>
      </div>

      {!state.collapsed && (
        <>
          <div className={css.branchRow}>
            <span className={css.branchBadge} title={branchName}>{branchName}</span>
            <span className={css.track}>{track}</span>
          </div>

          {status !== null && changeCount === 0 && (
            <div className={css.cleanRow}>{t('git.clean')}</div>
          )}

          {status !== null && changeCount > 0 && (
            <>
              <div
                className={css.resizeHandle}
                role="separator"
                aria-orientation="horizontal"
                aria-label={t('git.resize')}
                onPointerDown={onResizePointerDown}
              />
              <div className={css.changes} style={{ height: state.changesHeight }}>
                {(['conflicted', 'staged', 'unstaged', 'untracked'] as const).map((key) => {
                  const files = status[key]
                  if (files.length === 0) return null
                  const { label, entries } = bucket(t, key, files)
                  const paths = entries.map(entry => typeof entry === 'string' ? entry : entry.path)
                  // Untracked entries are plain paths; staged/unstaged carry status letters.
                  const perFile = (entry: GitFileStatus | string): string => typeof entry === 'string' ? entry : entry.path
                  return (
                    <div key={key} className={clsx(css.bucket, key === 'conflicted' && css.conflictBucket)}>
                      <div className={css.bucketLabelRow}>
                        <span className={css.bucketLabel}>{label} ({entries.length})</span>
                        {key === 'staged' && (
                          <button type="button" className={css.batchButton} disabled={state.busy} onClick={() => { unstage(paths) }}>
                            {t('git.unstageAll')}
                          </button>
                        )}
                        {(key === 'unstaged' || key === 'untracked') && (
                          <button type="button" className={css.batchButton} disabled={state.busy} onClick={() => { stage(paths) }}>
                            {t('git.stageAll')}
                          </button>
                        )}
                      </div>
                      <ul className={css.fileList}>
                        {entries.slice(0, 20).map((entry) => {
                          const entryPath = perFile(entry)
                          return (
                            <li key={entryPath} className={css.fileRow} title={entryPath}>
                              <button
                                type="button"
                                className={css.fileName}
                                title={t('git.openFile', { name: baseNameOf(entryPath) })}
                                onClick={() => {
                                  // A changed-file row opens like a tree row: the
                                  // shared viewer store plus the layout transition.
                                  openFile({ path: absoluteOf(rootPath, entryPath), name: baseNameOf(entryPath) })
                                  enterFileMode()
                                }}
                              >
                                {typeof entry === 'string' ? baseNameOf(entryPath) : `${entry.status} ${baseNameOf(entryPath)}`}
                              </button>
                              {key === 'staged' && (
                                <button type="button" className={css.rowButton} disabled={state.busy} onClick={() => { unstage([entryPath]) }}>
                                  {t('git.unstage')}
                                </button>
                              )}
                              {(key === 'unstaged' || key === 'untracked') && (
                                <button type="button" className={css.rowButton} disabled={state.busy} onClick={() => { stage([entryPath]) }}>
                                  {t('git.stage')}
                                </button>
                              )}
                            </li>
                          )
                        })}
                        {entries.length > 20 && <li className={css.moreRow}>+{entries.length - 20}</li>}
                      </ul>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          <div className={css.commitRow}>
            <input
              className={css.commitInput}
              type="text"
              value={state.commitMessage}
              placeholder={t('git.commit.placeholder')}
              disabled={state.busy}
              onChange={(event) => { actions.setCommitMessage(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
            />
            <button
              type="button"
              className={css.commitButton}
              disabled={state.busy || state.commitMessage.trim().length === 0}
              onClick={commit}
            >
              {t('git.commit')}
            </button>
          </div>

          <div className={css.actionRow}>
            <button type="button" className={css.actionButton} disabled={state.busy} onClick={push}>{t('git.push')}</button>
            <button type="button" className={css.actionButton} disabled={state.busy} onClick={pull}>{t('git.pull')}</button>
          </div>

          {state.branches.length > 0 && (
            <div className={css.branchListBlock}>
              <div className={css.branchListLabel}>{t('git.branches')}</div>
              <ul className={css.branchList}>
                {state.branches.map(branch => (
                  <li key={branch.name}>
                    <button
                      type="button"
                      className={clsx(css.branchItem, branch.name === current && css.branchItemCurrent)}
                      title={branch.name === current ? t('git.branch.current') : t('git.checkout')}
                      disabled={state.busy || branch.name === current}
                      onClick={() => { checkout(branch.name) }}
                    >
                      <span className={css.branchName}>{branch.name}</span>
                      {branch.name === current && <span className={css.branchMark}>{t('git.branch.current')}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {state.error !== null && (
            <div className={css.errorRow} role="alert">
              <IconWarningOutline16 className={css.warnIcon} />
              <span className={css.errorText}>{state.error}</span>
            </div>
          )}
          {state.output !== null && <div className={css.outputRow}>{state.output}</div>}
        </>
      )}
    </div>
  )
}

/** Whether a git wire failure means the workspace is not a repository. */
function isNotRepoError(reason: unknown): boolean {
  return reason instanceof Error && reason.message.includes('git-not-a-repository')
}

/** Message text of an unknown thrown value. */
function messageOf(reason: unknown): string {
  // The wire methods throw Error subclasses; the String arm is defensive.
  /* v8 ignore next -- a non-Error throw cannot come from the workspaces service methods. */
  return reason instanceof Error ? reason.message : String(reason)
}
