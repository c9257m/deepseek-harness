/**
 * Workspace-file viewer preferences stored in the Host user-settings document.
 * The namespace is registered Host-side by this package's node half; the
 * browser scope binds the same namespace and syncs the shared store.
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the workspace-file browser plugin. */
export const WORKSPACE_FILES_SETTINGS_NAMESPACE = 'workspace-files'

/** Field carrying the code body's font size in px. */
export const FONT_SIZE_FIELD = 'fontSize'

/** Default font size when the user-settings document has no override. */
export const DEFAULT_FONT_SIZE = 12

/** Stepper lower bound (px). */
export const FONT_SIZE_MIN = 10

/** Stepper upper bound (px). */
export const FONT_SIZE_MAX = 24

/** Durable section shared by the Host schema and the browser scope. */
export interface WorkspaceFilesSettings {
  /** Code-body font size in px. */
  fontSize: number
}

/** Durable section schema; also the wire envelope the browser scope validates against. */
export const WorkspaceFilesSettingsSchema: z<WorkspaceFilesSettings> = z.object({
  [FONT_SIZE_FIELD]: z.natural().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).default(DEFAULT_FONT_SIZE),
})

/**
 * Narrow one wire or registry value to a persistable font size.
 * @param value - value crossing the settings boundary.
 * @returns whether the value is an in-range font size.
 */
export function isFontSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= FONT_SIZE_MIN && value <= FONT_SIZE_MAX
}
