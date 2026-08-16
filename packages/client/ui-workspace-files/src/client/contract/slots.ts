/**
 * ui-workspace-files contracts. Two registrations share one store handle:
 *
 * - FileTree fills the sidebar shell's `sidebar.files` hole — the current
 *   session workspace's file hierarchy as a lazy tree. Clicking a file opens
 *   it in the shared store (added to the tab list when absent) and flips the
 *   layout into file mode (the viewer takes the center column, the
 *   conversation docks into the right track).
 * - FileViewer fills the layout's `workspace.fileViewer` hole — the center
 *   column's occupant in file mode. It renders the open tabs with per-type
 *   badges, syntax-highlighted code with an optional line-number gutter, and
 *   right-click menus (close tabs; toggle line numbers / highlighting). Its
 *   close gestures clear the store and exit file mode when the last tab
 *   closes.
 *
 * The layout owns the file-mode flag (via `ctx.layout`); the open tabs and
 * display preferences live in this package's shared store. Both facts change
 * together: opening a tab sets the store and enters file mode, closing the
 * last tab clears the store and exits.
 */
import type {
  HostObservable, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the owner SlotMap merges (sidebar.files / workspace.fileViewer)
// into programs that resolve the runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import type { createFileBrowserStore } from '../stores.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The git quick-action panel beneath the file tree. Declared by this
     * package as the FileTree entry's child hole (declaring is claiming); the
     * workspace-git plugin registers the panel and receives no owner props.
     */
    'sidebar.files.git': { kind: 'single'; scope: 'root'; owner: GitPanelOwnerProps }
  }
}

/** Owner share of the git-panel hole: the file tree passes nothing today. */
export interface GitPanelOwnerProps {}

/** Tree-private injected share: the browse wire call and the layout transition. */
export interface FileBrowserInjected {
  /** List one directory level (absent path = the Host home directory); the signal aborts a superseded scan. */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Enter file mode: the viewer takes the center column, the conversation docks right. */
  enterFileMode: () => void
}

/**
 * Viewer-private injected share: the read wire call, the layout transition,
 * and the highlighter's lazy-grammar load observable. The grammar source rides
 * the reserved `hooks` compartment: the renderer binds it into the
 * `useGrammarLoaded` selector hook, so the viewer re-renders (and re-highlights)
 * when a lazily imported grammar registers.
 */
export interface FileViewerInjected {
  /** Read a regular text file (bounded by the Host's byte cap). */
  readFile: (path: string, signal?: AbortSignal) => Promise<string>
  /** Replace a text file's whole content atomically (the auto-save write). */
  writeFile: (path: string, content: string) => Promise<void>
  /** Exit file mode: the conversation returns to the center column. */
  exitFileMode: () => void
  hooks: {
    /** Bumped on each lazy-grammar load completion (ui-primitives highlighter). */
    grammarLoaded: HostObservable<number>
  }
}

/** Viewer-side view of the grammar-load share: the bound selector hook. */
export type FileViewerHooks = {
  /** Selector hook over the highlighter's lazy-grammar load count. */
  useGrammarLoaded: SnapshotSelectorHook<number>
}

/** Full tree props: the sidebar owner share + the shared store + injected actions + locale. */
export type FileTreeProps =
  PropsRuntime<'sidebar.files'>
  & PropsRenderSlots<'sidebar.files.git'>
  & PropsStore<ReturnType<typeof createFileBrowserStore>>
  & FileBrowserInjected
  & PropsLocale<'workspace-files'>

/** Full viewer props: the layout owner share + the shared store + injected actions + hooks + locale. */
export type FileViewerProps =
  PropsRuntime<'workspace.fileViewer'>
  & PropsStore<ReturnType<typeof createFileBrowserStore>>
  & Omit<FileViewerInjected, 'hooks'>
  & FileViewerHooks
  & PropsLocale<'workspace-files'>
