/**
 * The workspace-file browser's shared store: the open-file tab list both
 * entries (the sidebar tree and the center viewer) read and write, plus the
 * viewer's display preferences (line numbers, syntax highlighting, code font
 * size). The font size mirrors the durable user-settings namespace; the
 * settings binding in apply is its only writer. Module level exports the
 * factory only — a module-level handle would pin the store's identity in the
 * module cache (a de-facto singleton surviving plugin reloads). register()
 * receives one pre-created handle shared by the registrations inside apply
 * (same scope, one instantiation), so the tree's open gesture, the viewer's
 * tab bar, and the settings row drive the same state.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import { DEFAULT_FONT_SIZE } from '../settings.ts'

/** A file opened in the viewer: its absolute host path plus its base name. */
export interface OpenFileRef {
  /** Absolute host path (the client never joins path segments itself). */
  path: string
  /** Base name shown in the tab. */
  name: string
}

/**
 * Store state: the open tabs in open order, the active tab's path (null when
 * no tab is open), and the viewer display preferences shared across tabs.
 */
type FileBrowserState = {
  files: readonly OpenFileRef[]
  activePath: string | null
  /** Whether the code body renders the line-number gutter. */
  showLineNumbers: boolean
  /** Whether the code body runs syntax highlighting (unknown languages render plain either way). */
  highlight: boolean
  /** Code-body font size in px (mirror of the durable user setting). */
  fontSize: number
}

/** Annotation twin of the actions literal below. */
type FileBrowserActions = {
  /** Open a file: append it when absent, then activate it. */
  openFile: (draft: FileBrowserState, file: OpenFileRef) => void
  /** Activate an already-open tab (no-op for an unknown path). */
  activateFile: (draft: FileBrowserState, path: string) => void
  /**
   * Close one tab. Closing the active tab activates its left neighbor (the
   * last tab when it was the rightmost); closing the last tab clears the
   * selection.
   */
  closeFile: (draft: FileBrowserState, path: string) => void
  /** Close every tab except `path` (no-op when the path is not open). */
  closeOthers: (draft: FileBrowserState, path: string) => void
  /** Close every tab. */
  closeAll: (draft: FileBrowserState) => void
  toggleLineNumbers: (draft: FileBrowserState) => void
  toggleHighlight: (draft: FileBrowserState) => void
  /** Replace the code-body font size (px). */
  setFontSize: (draft: FileBrowserState, size: number) => void
}

/**
 * Create the file browser store handle. Tab activation and the display
 * preferences are the only shared facts; tree expansion and per-level
 * listings are tree-local and stay in component state.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createFileBrowserStore(): EngineStoreHandle<FileBrowserState, FileBrowserActions> {
  const handle = defineStore({
    init: (): FileBrowserState => ({
      files: [], activePath: null, showLineNumbers: true, highlight: true, fontSize: DEFAULT_FONT_SIZE,
    }),
    actions: {
      openFile: (d, file: OpenFileRef) => {
        if (!d.files.some(candidate => candidate.path === file.path)) {
          d.files = [...d.files, file]
        }
        d.activePath = file.path
      },
      activateFile: (d, path: string) => {
        if (d.files.some(candidate => candidate.path === path)) d.activePath = path
      },
      closeFile: (d, path: string) => {
        const index = d.files.findIndex(candidate => candidate.path === path)
        if (index === -1) return
        const files = d.files.filter(candidate => candidate.path !== path)
        d.files = files
        if (d.activePath === path) {
          d.activePath = files.length === 0
            ? null
            : (files[Math.min(index, files.length - 1)]?.path ?? null)
        }
      },
      closeOthers: (d, path: string) => {
        const keep = d.files.find(candidate => candidate.path === path)
        if (keep === undefined) return
        d.files = [keep]
        d.activePath = path
      },
      closeAll: (d) => {
        d.files = []
        d.activePath = null
      },
      toggleLineNumbers: (d) => { d.showLineNumbers = !d.showLineNumbers },
      toggleHighlight: (d) => { d.highlight = !d.highlight },
      setFontSize: (d, size: number) => { d.fontSize = size },
    },
  })
  return handle
}
