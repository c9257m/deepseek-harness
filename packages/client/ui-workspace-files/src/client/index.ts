/**
 * Browser half of the workspace-file browser plugin: registers the sidebar
 * file tree into the sidebar shell's `sidebar.files` hole and the file viewer
 * into the layout's `workspace.fileViewer` hole, sharing one open-file store
 * handle between the two entries. Opening a file (tree row click) writes the
 * shared store and flips the layout into file mode through `ctx.layout`;
 * closing (viewer close button) clears the store and exits file mode.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and the
// SlotMap merges declaring the holes and the General settings item seat.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { grammarLoadCount, subscribeGrammarLoaded } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileBrowserInjected, FileViewerInjected } from './contract/slots.ts'
import {
  FONT_SIZE_FIELD, WORKSPACE_FILES_SETTINGS_NAMESPACE, type WorkspaceFilesSettings,
} from '../settings.ts'
import { createFileBrowserStore } from './stores.ts'
import { FileTree } from './FileTree.tsx'
import { FileViewer } from './FileViewer.tsx'
import { FontSizeRow, type FontSizeRowInjected } from './FontSizeRow.tsx'
import { en, zh, type WorkspaceFilesKey } from './locales.ts'

// The contract's exported types ride the client barrel so the slot child
// (ui-workspace-git) pulls the SlotMap merge through one import.
export type { FileBrowserInjected, FileViewerInjected, GitPanelOwnerProps } from './contract/slots.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace file tree and file viewer copy. */
    'workspace-files': WorkspaceFilesKey
  }
}

/** Locale namespace owning the tree and viewer copy. */
const NS = 'workspace-files'

// The highlighter's lazy-grammar load observable: a module constant so the
// hook binding keeps one source identity across every render (the renderer
// caches `use<Name>` bindings per source object).
const grammarLoadedSource = {
  getSnapshot: () => grammarLoadCount(),
  subscribe: (listener: () => void) => subscribeGrammarLoaded(listener),
}

/** Required services (cordis fiber inject): slots, the wire-facing workspaces service, the layout face,
 * settings (transport + scope), and locale. */
export const inject = ['slots', 'workspaces', 'layout', 'connection', 'remote', 'settingsScope', 'locale']

/**
 * Client plugin body: register the dictionaries and the entries through
 * `slots.inject()` because the sidebar, layout, and General-settings entries
 * may activate later or replace their declarations. The registrations share
 * one pre-created store handle (same root scope — one instantiation, one
 * open-tab state); the durable font-size preference binds through
 * `ctx.settingsScope` and syncs into the store, so the settings row and the
 * viewer read the same value.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace-files: dictionaries')

  ctx.effect(() => {
    const store = createFileBrowserStore()
    // Durable viewer preferences: bind the namespace scope and mirror its
    // font size into the shared store (the settings row and the viewer read
    // the store; the row writes back through the scope).
    const host = ctx.settingsScope.bind<WorkspaceFilesSettings>({ namespace: WORKSPACE_FILES_SETTINGS_NAMESPACE })
    let bound: BoundActions<typeof store> | undefined
    const syncFontSize = (): void => {
      const value = host.getSnapshot().value
      if (value !== undefined) bound?.setFontSize(value.fontSize)
    }
    const unsubscribe = host.subscribe(syncFontSize)

    const treeInjected = (): FileBrowserInjected => ({
      listDirectory: (path, signal) => ctx.workspaces.listDirectory(path, signal),
      enterFileMode: () => { ctx.layout.openFileMode() },
    })
    const viewerInjected = (): FileViewerInjected => ({
      readFile: (path, signal) => ctx.workspaces.readFile(path, signal),
      writeFile: (path, content) => ctx.workspaces.writeFile(path, content),
      exitFileMode: () => { ctx.layout.closeFileMode() },
      hooks: { grammarLoaded: grammarLoadedSource },
    })
    const rowInjected = (actions: BoundActions<typeof store>): FontSizeRowInjected => {
      bound = actions
      // Re-sync from the snapshot so no change is lost between the scope
      // binding and the row's first render.
      syncFontSize()
      return {
        setFontSize: (size) => { void host.set(FONT_SIZE_FIELD, size) },
      }
    }
    const disposers: (() => void)[] = [
      unsubscribe,
      ctx.slots.inject('sidebar.files', () =>
        ctx.slots.register({
          name: 'sidebar.files',
          locale: NS,
          store,
          // The git quick-action panel (ui-workspace-git) fills this child hole
          // beneath the tree; declared here so the sidebar shell's owner
          // contract stays with the files feature.
          children: {
            'sidebar.files.git': { kind: 'single', scope: 'root' },
          },
          inject: treeInjected,
        }, FileTree)),
      ctx.slots.inject('workspace.fileViewer', () =>
        ctx.slots.register({
          name: 'workspace.fileViewer',
          locale: NS,
          store,
          inject: viewerInjected,
        }, FileViewer)),
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register({
          name: 'settings.general.item',
          id: 'file-font-size',
          order: 30,
          locale: NS,
          store,
          inject: rowInjected,
        }, FontSizeRow)),
    ]
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'ui-workspace-files: registrations')
}
