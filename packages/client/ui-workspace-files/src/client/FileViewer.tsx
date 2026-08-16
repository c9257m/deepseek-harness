/**
 * The file viewer filling the layout's `workspace.fileViewer` hole — the
 * center column's occupant in file mode. Renders the shared store's open
 * tabs: a tab bar with per-type file badges (right-click to close, close
 * others, close all) and an edit toggle, and a code body that
 * syntax-highlights per language (via the ui-primitives highlighter, lazily
 * loaded grammars re-render on load) with an optional line-number gutter.
 * The body's right-click menu toggles line numbers and highlighting.
 *
 * Tabs of readable text files can be edited in place: the edit toggle swaps
 * the highlighted body for a plain-text editor, edits are **auto-saved**
 * through `writeFile` after a debounce (and flushed on tab switch or close),
 * dirty tabs carry a dot, and a failed save shows an error bar with Retry.
 * Read failures map the Host's business codes onto localized copy: too
 * large, not text, unreadable. Closing the last tab clears the store and
 * exits file mode through the injected `exitFileMode`, returning the
 * conversation to the center column.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  highlightLines, IconCloseFill14, IconEditOutline16, Menu, type HighlightSpan,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileViewerProps } from './contract/slots.ts'
import { FileIcon } from './FileIcon.tsx'
import { languageOf } from './file-type.ts'
import css from './FileViewer.module.css'

/** Read-state of one tab's body. */
type ReadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Idle pause after the latest keystroke before an auto-save fires. */
const AUTOSAVE_DELAY_MS = 1000

/** A zero-size DOMRect at a pointer position (Menu's portal anchor rect). */
function rectAt(x: number, y: number): DOMRect {
  return {
    left: x, top: y, width: 0, height: 0, x, y, right: x, bottom: y,
    toJSON: () => ({ left: x, top: y, width: 0, height: 0 }),
  }
}

/** Localized copy for a read failure, keyed by the Host's business code. */
function errorCopy(t: FileViewerProps['t'], code: string, message: string): string {
  switch (code) {
    case 'file-too-large': return t('viewer.error.tooLarge')
    case 'file-not-text': return t('viewer.error.notText')
    case 'file-unreadable': return t('viewer.error.unreadable')
    default: return t('viewer.error.generic', { message })
  }
}

/** The code body split into the caller's own line array (one trailing newline normalized away). */
function linesOf(content: string): string[] {
  return content.replace(/\n$/, '').split('\n')
}

/** Render the file viewer (see module doc). */
export function FileViewer({
  useStore, actions, readFile, writeFile, exitFileMode, useGrammarLoaded, t,
}: FileViewerProps) {
  const files = useStore(s => s.files)
  const activePath = useStore(s => s.activePath)
  const showLineNumbers = useStore(s => s.showLineNumbers)
  const highlight = useStore(s => s.highlight)
  const fontSize = useStore(s => s.fontSize)
  // Re-render (and re-highlight) when a lazily imported grammar registers.
  useGrammarLoaded(() => 0)
  const open = files.find(candidate => candidate.path === activePath) ?? null

  // Per-tab content cache: a file is fetched once per viewer session; the
  // active tab's body is derived from the cache. `fetched` (a ref) records the
  // paths already requested so the effect never re-fetches on re-renders or
  // tab switches, and each settlement writes its OWN path's cache key — a slow
  // read for a switched-away tab can never paint over the active tab, it only
  // fills that tab's cache for when the user returns. Errors live beside
  // content so a failed read is not re-attempted on every activation.
  const [contents, setContents] = useState<Readonly<Record<string, string>>>({})
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const fetched = useRef(new Set<string>())
  const openPath = open?.path

  useEffect(() => {
    if (openPath === undefined || fetched.current.has(openPath)) return
    fetched.current.add(openPath)
    readFile(openPath).then((text) => {
      setContents(prev => ({ ...prev, [openPath]: text }))
    }).catch((reason: unknown) => {
      const rpcError = (reason as { rpcError?: { code?: string; message?: string } } | null)?.rpcError
      setErrors(prev => ({
        ...prev,
        [openPath]: rpcError === undefined
          ? (reason instanceof Error ? reason.message : String(reason))
          : errorCopy(t, rpcError.code ?? '', rpcError.message ?? ''),
      }))
    })
  }, [openPath, readFile, t])

  const status: ReadStatus = openPath === undefined
    ? 'idle'
    : contents[openPath] !== undefined
      ? 'ready'
      : errors[openPath] !== undefined
        ? 'error'
        : 'loading'
  const content = openPath === undefined ? null : (contents[openPath] ?? null)

  // Highlighted per-line runs, or undefined when the language is unknown or
  // its grammar is still loading (plain-text fallback; the grammar hook
  // re-renders this memo once the grammar registers).
  const highlighted = useMemo(() => {
    if (open === null || content === null || !highlight || content === '') return undefined
    return highlightLines(content, languageOf(open.name))
  }, [open, content, highlight])

  // ── Editing + auto-save ────────────────────────────────────────────────
  // Per-tab edit state: which tabs are in edit mode, their drafts, and which
  // carry unsaved changes. Drafts and dirty sets are mirrored into refs so the
  // debounced save timer reads the latest values without stale closures. Only
  // successfully read text tabs are editable (binary/too-large/error tabs
  // keep the read-only body and a disabled toggle).
  const [editingPaths, setEditingPaths] = useState<ReadonlySet<string>>(new Set())
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set())
  const [saveErrors, setSaveErrors] = useState<Readonly<Record<string, string>>>({})
  const draftsRef = useRef<Record<string, string>>({})
  const dirtyRef = useRef<Set<string>>(new Set())
  const autosaveTimer = useRef<number | null>(null)

  const savePath = async (path: string): Promise<void> => {
    const draft = draftsRef.current[path]
    if (draft === undefined || !dirtyRef.current.has(path)) return
    try {
      await writeFile(path, draft)
      dirtyRef.current.delete(path)
      setDirty((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      // The saved text is now the authoritative content (a later re-read would
      // fetch it anyway); update the cache so exiting edit mode renders it.
      setContents(prev => ({ ...prev, [path]: draft }))
      setSaveErrors((prev) => {
        if (!Object.hasOwn(prev, path)) return prev
        return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== path))
      })
    } catch (reason: unknown) {
      setSaveErrors(prev => ({
        ...prev,
        [path]: t('viewer.save.error', { message: reason instanceof Error ? reason.message : String(reason) }),
      }))
    }
  }

  /** Save every dirty tab immediately, cancelling the pending debounce. */
  const flushDirty = (): void => {
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }
    for (const path of dirtyRef.current) void savePath(path)
  }

  /** Mark one tab's draft changed and schedule the auto-save. */
  const setDraft = (path: string, value: string): void => {
    draftsRef.current = { ...draftsRef.current, [path]: value }
    setDrafts(prev => ({ ...prev, [path]: value }))
    dirtyRef.current.add(path)
    setDirty(prev => new Set(prev).add(path))
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current)
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null
      flushDirty()
    }, AUTOSAVE_DELAY_MS)
  }

  /** Toggle the active tab between edit and read-only; leaving edit flushes a pending save. */
  const toggleEditing = (): void => {
    if (openPath === undefined || content === null) return
    setEditingPaths((prev) => {
      const next = new Set(prev)
      if (next.has(openPath)) {
        next.delete(openPath)
        flushDirty()
      } else {
        next.add(openPath)
      }
      return next
    })
  }

  const editing = openPath !== undefined && editingPaths.has(openPath)
  const dirtyTab = (path: string): boolean => dirty.has(path)
  const saveError = openPath === undefined ? undefined : saveErrors[openPath]

  /** The tab a right-click opened a menu for (path + pointer position). */
  const [tabMenu, setTabMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  /** The body right-click menu position. */
  const [bodyMenu, setBodyMenu] = useState<{ x: number; y: number } | null>(null)

  const closeTab = (path: string): void => {
    // Flush pending edits before the tab leaves so nothing typed is lost.
    flushDirty()
    const wasLast = files.length === 1 && files[0]?.path === path
    actions.closeFile(path)
    if (wasLast) exitFileMode()
  }

  const closeAllTabs = (): void => {
    if (files.length === 0) return
    flushDirty()
    actions.closeAll()
    exitFileMode()
  }

  if (files.length === 0) {
    return (
      <div className={clsx(css.root, css.empty)}>
        <span className={css.emptyGlyph}>TXT</span>
        <span>{t('viewer.empty')}</span>
      </div>
    )
  }

  return (
    <div className={css.root}>
      <div className={css.tabBar} role="tablist" aria-label={t('viewer.close.label')}>
        {files.map((file) => {
          const active = file.path === openPath
          const unsaved = dirtyTab(file.path)
          return (
            <div
              key={file.path}
              role="tab"
              aria-selected={active || undefined}
              title={unsaved ? t('viewer.unsaved') : file.path}
              className={clsx(css.tab, active && css.tabActive)}
              onClick={() => {
                // Flush pending edits before the body switches away.
                flushDirty()
                actions.activateFile(file.path)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                setBodyMenu(null)
                setTabMenu({ path: file.path, x: event.clientX, y: event.clientY })
              }}
            >
              <FileIcon name={file.name} size={13} />
              <span className={css.tabName}>{file.name}</span>
              {unsaved && <span className={css.dirtyDot} aria-hidden="true" />}
              <button
                type="button"
                className={css.tabClose}
                aria-label={t('viewer.tab.close', { name: file.name })}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(file.path)
                }}
              >
                <IconCloseFill14 />
              </button>
            </div>
          )
        })}
        {/* Edit toggle for the active tab (enabled only for readable text). */}
        <button
          type="button"
          className={clsx(css.editToggle, editing && css.editToggleActive)}
          aria-pressed={editing}
          disabled={openPath === undefined || content === null}
          title={content === null ? t('viewer.edit.unavailable') : undefined}
          onClick={toggleEditing}
        >
          <IconEditOutline16 size={13} />
          <span>{editing ? t('viewer.edit.done') : t('viewer.edit')}</span>
        </button>
      </div>
      <div
        className={css.body}
        onContextMenu={(event) => {
          event.preventDefault()
          setTabMenu(null)
          setBodyMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        {status === 'loading' && <div className={css.status} role="status">{t('viewer.loading')}</div>}
        {status === 'error' && openPath !== undefined && <div className={css.error} role="alert">{errors[openPath]}</div>}
        {saveError !== undefined && (
          <div className={css.saveError} role="alert">
            <span className={css.saveErrorText}>{saveError}</span>
            <button type="button" className={css.saveRetry} onClick={() => { if (openPath !== undefined) void savePath(openPath) }}>
              {t('viewer.save.retry')}
            </button>
          </div>
        )}
        {(status === 'ready' || status === 'idle') && content !== null && (editing ? (
          <textarea
            className={css.editor}
            style={{ fontSize }}
            spellCheck={false}
            value={drafts[openPath] ?? content}
            onChange={(event) => {
              setDraft(openPath, event.target.value)
            }}
          />
        ) : (
          <div className={css.code} style={{ fontSize }} data-line-numbers={showLineNumbers || undefined}>
            {highlighted === undefined
              ? linesOf(content).map((line, index) => (
                <div key={index} className={css.codeLine}>
                  {showLineNumbers && <span className={css.gutter}>{index + 1}</span>}
                  <span className={css.lineText}>{line === '' ? '\u00A0' : line}</span>
                </div>
              ))
              : highlighted.map((runs, index) => (
                <div key={index} className={css.codeLine}>
                  {showLineNumbers && <span className={css.gutter}>{index + 1}</span>}
                  <span className={css.lineText}>
                    {runs.length === 0 ? '\u00A0' : runs.map((run, runIndex) => (
                      <HighlightedRun key={runIndex} run={run} />
                    ))}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>

      {/* Tab context menu: close / close others / close all. */}
      <Menu
        open={tabMenu !== null}
        onClose={() => { setTabMenu(null) }}
        items={[
          { id: 'close', label: t('viewer.menu.close'), danger: true },
          { type: 'separator', id: 'tab-close-separator' },
          { id: 'close-others', label: t('viewer.menu.closeOthers') },
          { id: 'close-all', label: t('viewer.menu.closeAll') },
        ]}
        onSelect={(id) => {
          const target = tabMenu?.path
          if (target !== undefined) {
            if (id === 'close') closeTab(target)
            else if (id === 'close-others') actions.closeOthers(target)
            else if (id === 'close-all') closeAllTabs()
          }
          setTabMenu(null)
        }}
        align="start"
        portal
        getAnchorRect={() => tabMenu === null ? null : rectAt(tabMenu.x, tabMenu.y)}
        anchor={<span className={css.menuAnchor} />}
      />

      {/* Body context menu: display toggles. */}
      <Menu
        open={bodyMenu !== null}
        onClose={() => { setBodyMenu(null) }}
        items={[
          { id: 'line-numbers', label: t('viewer.menu.lineNumbers') },
          { id: 'highlight', label: t('viewer.menu.highlight') },
        ]}
        selectedIds={[
          ...(showLineNumbers ? ['line-numbers' as const] : []),
          ...(highlight ? ['highlight' as const] : []),
        ]}
        onSelect={(id) => {
          if (id === 'line-numbers') actions.toggleLineNumbers()
          else if (id === 'highlight') actions.toggleHighlight()
          setBodyMenu(null)
        }}
        align="start"
        portal
        getAnchorRect={() => bodyMenu === null ? null : rectAt(bodyMenu.x, bodyMenu.y)}
        anchor={<span className={css.menuAnchor} />}
      />
    </div>
  )
}

/** One highlighted run: the text plus the theme token color shiki assigned. */
function HighlightedRun({ run }: { run: HighlightSpan }) {
  return <span style={run.style}>{run.text}</span>
}
