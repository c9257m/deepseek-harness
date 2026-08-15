/**
 * The workspace file tree filling the sidebar shell's `sidebar.files` hole.
 * Roots at the current Session's canonical cwd; directories expand lazily
 * (one `listDirectory` call per opened level, cached in local state), files
 * are leaves. Clicking a file writes the shared open-file store and flips the
 * layout into file mode through the injected `enterFileMode` — the viewer
 * takes the center column and the conversation docks into the right track.
 * Hidden entries (dot-prefixed on POSIX) are filtered out, matching the
 * directory picker's default posture.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronRightOutline14, IconFolderClose16, IconFolderOpen16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryEntry } from '@deepseek-ai/dsh-client-runtime/client'
import type { FileTreeProps } from './contract/slots.ts'
import { FileIcon } from './FileIcon.tsx'
import css from './FileTree.module.css'

/** Base name of an absolute host path (both separators, root falls back to the path itself). */
export function baseNameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? path
}

/** Render one directory level's rows; empty levels render nothing beneath an expanded directory. */
export function FileTree({ wide, useSessions, actions, listDirectory, enterFileMode, t }: FileTreeProps) {
  const sessions = useSessions(s => s)
  const currentId = sessions.current
  const rootPath = currentId === undefined ? undefined : sessions.byId[currentId]?.cwd
  // Per-level listing cache (undefined = not loaded yet), the expanded-path
  // set, and per-level failures. All tree-local presentation state.
  const [levels, setLevels] = useState<Readonly<Record<string, readonly DirectoryEntry[] | undefined>>>({})
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [levelErrors, setLevelErrors] = useState<Readonly<Record<string, string>>>({})
  // Supersession counter: a newer root or level request invalidates stale
  // settlements instead of letting an abandoned scan paint over the tree.
  const loadSeq = useRef(0)

  const listLevel = (path: string): void => {
    const seq = ++loadSeq.current
    setLevelErrors((prev) => {
      if (!Object.hasOwn(prev, path)) return prev
      return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== path))
    })
    listDirectory(path).then((listing) => {
      if (seq !== loadSeq.current) return
      setLevels(prev => ({ ...prev, [path]: listing.entries }))
    }).catch((reason: unknown) => {
      if (seq !== loadSeq.current) return
      setLevels(prev => ({ ...prev, [path]: [] }))
      setLevelErrors(prev => ({ ...prev, [path]: reason instanceof Error ? reason.message : String(reason) }))
    })
  }

  // A new root (or the first session) resets the tree and loads the root level.
  useEffect(() => {
    loadSeq.current += 1
    setLevels({})
    setExpanded([])
    setLevelErrors({})
    if (rootPath === undefined) return
    listLevel(rootPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listLevel is stable enough for a root reset (recreated per render).
  }, [rootPath])

  const toggleDir = (path: string): void => {
    if (expanded.includes(path)) {
      setExpanded(prev => prev.filter(candidate => candidate !== path))
      return
    }
    setExpanded(prev => [...prev, path])
    if (levels[path] === undefined) listLevel(path)
  }

  const openFile = (entry: DirectoryEntry): void => {
    actions.openFile({ path: entry.path, name: entry.name })
    enterFileMode()
  }

  const renderLevel = (path: string, depth: number): ReactNode => {
    const entries = levels[path] ?? []
    return entries.filter(entry => !entry.hidden).map((entry) => {
      if (entry.kind === 'directory') {
        const open = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={css.dirRow}
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-expanded={open}
              onClick={() => { toggleDir(entry.path) }}
            >
              <IconChevronRightOutline14 size={12} className={clsx(css.chevron, open && css.chevronOpen)} />
              {open ? <IconFolderOpen16 size={14} className={css.rowIcon} /> : <IconFolderClose16 size={14} className={css.rowIcon} />}
              <span className={css.rowName}>{entry.name}</span>
            </button>
            {open && (
              levels[entry.path] === undefined
                ? <div className={css.statusRow} style={{ paddingLeft: 28 + depth * 14 }}>{t('files.loading')}</div>
                : renderLevel(entry.path, depth + 1)
            )}
          </div>
        )
      }
      return (
        <button
          key={entry.path}
          type="button"
          className={css.fileRow}
          style={{ paddingLeft: 28 + depth * 14 }}
          onClick={() => { openFile(entry) }}
        >
          <FileIcon name={entry.name} size={14} />
          <span className={css.rowName}>{entry.name}</span>
        </button>
      )
    })
  }

  if (!wide) return null

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{t('files.title')}</span>
        {rootPath !== undefined && (
          <span className={css.path} title={rootPath}>{baseNameOf(rootPath)}</span>
        )}
      </div>
      <div className={css.body}>
        {rootPath === undefined ? (
          <div className={css.empty}>{t('files.empty.noSession')}</div>
        ) : levels[rootPath] === undefined ? (
          <div className={css.statusRow}>{t('files.loading')}</div>
        ) : levelErrors[rootPath] !== undefined ? (
          <div className={css.errorRow} role="alert">
            <IconWarningOutline16 className={css.errorIcon} />
            {t('files.error.loading', { message: levelErrors[rootPath] })}
          </div>
        ) : (
          <div role="tree" aria-label={t('files.title')}>
            {renderLevel(rootPath, 0)}
          </div>
        )}
      </div>
    </div>
  )
}
