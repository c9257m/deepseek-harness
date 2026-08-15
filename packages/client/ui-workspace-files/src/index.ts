/**
 * Workspace file browser plugin, node half. Registers the viewer-preference
 * settings namespace on the Host settings service when composed; the browser
 * half ships via exports["./client"] and binds the same namespace through
 * `ctx.settingsScope`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  WORKSPACE_FILES_SETTINGS_NAMESPACE, WorkspaceFilesSettingsSchema,
} from './settings.ts'

export { WORKSPACE_FILES_SETTINGS_NAMESPACE, WorkspaceFilesSettingsSchema } from './settings.ts'
export type { WorkspaceFilesSettings } from './settings.ts'

const WORKSPACE_FILES_NAMESPACE = settingsNamespace(WORKSPACE_FILES_SETTINGS_NAMESPACE)

/**
 * Register the durable viewer-preference section when the optional Host
 * settings service is composed.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(WORKSPACE_FILES_NAMESPACE, WorkspaceFilesSettingsSchema)
  })
}
