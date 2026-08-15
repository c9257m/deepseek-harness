// @vitest-environment jsdom
/**
 * Viewer-preference settings vocabulary: namespace/schema constants and the
 * font-size narrow function.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_SIZE, FONT_SIZE_MAX, FONT_SIZE_MIN, isFontSize, WorkspaceFilesSettingsSchema,
} from '@deepseek-ai/dsh-client-ui-workspace-files/src/settings.ts'
import type { WorkspaceFilesSettings } from '@deepseek-ai/dsh-client-ui-workspace-files/src/settings.ts'

describe('workspace-files settings', () => {
  it('resolves the font-size default and clamps out-of-range values through the schema', () => {
    // An absent section resolves through schema defaults; the input cast
    // matches how the Host resolution layer calls the schema.
    expect(WorkspaceFilesSettingsSchema({} as WorkspaceFilesSettings).fontSize).toBe(DEFAULT_FONT_SIZE)
    expect(WorkspaceFilesSettingsSchema({ fontSize: 18 }).fontSize).toBe(18)
    expect(() => WorkspaceFilesSettingsSchema({ fontSize: FONT_SIZE_MIN - 1 })).toThrow()
    expect(() => WorkspaceFilesSettingsSchema({ fontSize: FONT_SIZE_MAX + 1 })).toThrow()
  })

  it('isFontSize accepts exactly in-range integers', () => {
    expect(isFontSize(DEFAULT_FONT_SIZE)).toBe(true)
    expect(isFontSize(FONT_SIZE_MAX)).toBe(true)
    expect(isFontSize(FONT_SIZE_MIN - 1)).toBe(false)
    expect(isFontSize(FONT_SIZE_MAX + 1)).toBe(false)
    expect(isFontSize(12.5)).toBe(false)
    expect(isFontSize('12')).toBe(false)
    expect(isFontSize(undefined)).toBe(false)
  })
})
