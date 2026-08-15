/**
 * Per-type file badge: a small colored tile with a short glyph label (TS, { },
 * M↓, …) derived from the file extension. The glyph keeps the set readable at
 * 12–14px without an icon library; colors ride the theme's static palette
 * tokens only (FileIcon.module.css).
 */
import clsx from 'clsx'
import { fileIconOf } from './file-type.ts'
import css from './FileIcon.module.css'

/**
 * Render the file-type badge for a file name.
 * @param name - file base name.
 * @param size - badge side length in px.
 * @returns the badge element.
 */
export function FileIcon({ name, size = 14 }: { name: string; size?: number }) {
  const spec = fileIconOf(name)
  return (
    <span
      className={clsx(css.badge, css[spec.color])}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.62)) }}
      aria-hidden="true"
    >
      {spec.glyph}
    </span>
  )
}
