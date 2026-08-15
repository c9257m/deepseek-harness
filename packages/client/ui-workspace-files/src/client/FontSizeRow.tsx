/**
 * The file-font-size preference row registered into the General section item
 * slot (beside Appearance and Language): title plus a bounded stepper. The
 * value mirrors the durable `workspace-files` settings namespace through the
 * shared file-browser store; the write goes back through the settings scope.
 */
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../settings.ts'
import type { createFileBrowserStore } from './stores.ts'
import css from './FontSizeRow.module.css'

/** Injected business face: the preference write. */
export interface FontSizeRowInjected {
  /** Persist one font size (px). */
  setFontSize: (size: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontSizeRowComponentProps =
  PropsRuntime<'settings.general.item'>
  & PropsStore<ReturnType<typeof createFileBrowserStore>>
  & PropsLocale<'workspace-files'>
  & FontSizeRowInjected

/**
 * Render the file-font-size row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function FontSizeRow({ t, setFontSize, useStore }: FontSizeRowComponentProps) {
  const fontSize = useStore(s => s.fontSize)
  const down = fontSize <= FONT_SIZE_MIN
  const up = fontSize >= FONT_SIZE_MAX
  return (
    <div className={css.row}>
      <span className={css.title}>{t('viewer.fontSize')}</span>
      <div className={css.stepper}>
        <button
          type="button"
          className={clsx(css.step, down && css.disabled)}
          aria-label={t('viewer.fontSize.decrease')}
          disabled={down}
          onClick={() => { if (!down) setFontSize(fontSize - 1) }}
        >
          −
        </button>
        <span className={css.value} role="status">{fontSize}px</span>
        <button
          type="button"
          className={clsx(css.step, up && css.disabled)}
          aria-label={t('viewer.fontSize.increase')}
          disabled={up}
          onClick={() => { if (!up) setFontSize(fontSize + 1) }}
        >
          +
        </button>
      </div>
    </div>
  )
}
