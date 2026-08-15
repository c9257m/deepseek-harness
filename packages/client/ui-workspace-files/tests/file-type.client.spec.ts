// @vitest-environment jsdom
/**
 * File-type vocabulary: extension → language id (for the highlighter) and
 * extension → icon spec (for the per-type badge).
 */
import { describe, expect, it } from 'vitest'
import { fileIconOf, languageOf } from '@deepseek-ai/dsh-client-ui-workspace-files/src/client/file-type.ts'

describe('languageOf', () => {
  it('maps known extensions to highlighter language ids, case-insensitively', () => {
    expect(languageOf('main.ts')).toBe('typescript')
    expect(languageOf('MAIN.TSX')).toBe('typescript')
    expect(languageOf('app.js')).toBe('typescript')
    expect(languageOf('package.json')).toBe('json')
    expect(languageOf('README.md')).toBe('markdown')
    expect(languageOf('script.py')).toBe('python')
    expect(languageOf('style.css')).toBe('css')
    expect(languageOf('run.sh')).toBe('shellscript')
  })

  it('returns undefined for extension-less and unknown names', () => {
    expect(languageOf('Makefile')).toBeUndefined()
    expect(languageOf('notes.txt')).toBeUndefined()
    expect(languageOf('data.bin')).toBeUndefined()
    expect(languageOf('.gitignore')).toBeUndefined()
  })
})

describe('fileIconOf', () => {
  it('distinguishes file types with distinct glyphs and colors', () => {
    expect(fileIconOf('main.ts').glyph).toBe('TS')
    expect(fileIconOf('a.json').glyph).toBe('{ }')
    expect(fileIconOf('README.md').glyph).toBe('M↓')
    expect(fileIconOf('x.css').color).toBe('red')
    expect(fileIconOf('index.html').glyph).toBe('<>')
    expect(fileIconOf('deploy.sh').glyph).toBe('>_')
  })

  it('falls back to the neutral text badge for unknown and extension-less names', () => {
    expect(fileIconOf('notes.txt')).toEqual({ glyph: 'TXT', color: 'neutral' })
    expect(fileIconOf('LICENSE')).toEqual({ glyph: 'TXT', color: 'neutral' })
  })
})
