/**
 * Workspace git quick-action panel plugin, browser half: registers the panel
 * into the workspace file tree's declared `sidebar.files.git` child hole
 * (rendered beneath the tree). The panel derives the workspace path from the
 * standard sessions feed, calls the workspaces service's git methods through
 * the injected share, and uses the tree's open-file owner props so a
 * changed-file row opens in the shared viewer; no layout or settings coupling.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and the
// SlotMap merge declaring the sidebar.files.git hole.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace-files/client'
import type { GitPanelInjected } from './contract/slots.ts'
import { createGitPanelStore } from './stores.ts'
import { GitPanel } from './GitPanel.tsx'
import { en, zh, type WorkspaceGitKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace git quick-action panel copy. */
    'workspace-git': WorkspaceGitKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace-git'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * Register the git panel once the file tree declares its child hole. The
 * inject factories close over `ctx.workspaces` and return plain callbacks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace-git: dictionaries')

  const injected = (): GitPanelInjected => ({
    gitStatus: (path, signal) => ctx.workspaces.gitStatus(path, signal),
    gitCommit: (path, message) => ctx.workspaces.gitCommit(path, message),
    gitStage: (path, files, signal) => ctx.workspaces.gitStage(path, files, signal),
    gitUnstage: (path, files, signal) => ctx.workspaces.gitUnstage(path, files, signal),
    gitPush: (path, signal) => ctx.workspaces.gitPush(path, signal),
    gitPull: (path, signal) => ctx.workspaces.gitPull(path, signal),
    gitBranches: (path, signal) => ctx.workspaces.gitBranches(path, signal),
    gitCheckout: (path, branch) => ctx.workspaces.gitCheckout(path, branch),
  })

  ctx.effect(
    () => ctx.slots.inject('sidebar.files.git', () =>
      ctx.slots.register({
        name: 'sidebar.files.git',
        locale: NS,
        store: createGitPanelStore(),
        inject: injected,
      }, GitPanel)),
    'ui-workspace-git: registration',
  )
}
