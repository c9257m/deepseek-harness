/**
 * File-type vocabulary for the workspace file browser: extension → language id
 * (for the ui-primitives highlighter) and extension → icon group (for the
 * per-type file badge). Pure client-side mapping — the Host never participates.
 */

/**
 * The language id `highlightLines` resolves (a ui-primitives alias id: its
 * LANG_ALIASES vocabulary — 'typescript', 'json', 'markdown', 'python', …).
 * Undefined for extensions with no grammar (renders plain text).
 * @param name - file base name.
 * @returns the language id, or undefined for unknown/absent extensions.
 */
export function languageOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return undefined
  switch (name.slice(dot + 1).toLowerCase()) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs':
      return 'typescript'
    case 'json': case 'jsonc':
      return 'json'
    case 'md': case 'mdx':
      return 'markdown'
    case 'py':
      return 'python'
    case 'rb':
      return 'ruby'
    case 'rs':
      return 'rust'
    case 'go':
      return 'go'
    case 'java':
      return 'java'
    case 'c': case 'h':
      return 'c'
    case 'cpp': case 'cc': case 'hpp':
      return 'cpp'
    case 'cs':
      return 'csharp'
    case 'kt': case 'kts':
      return 'kotlin'
    case 'swift':
      return 'swift'
    case 'php':
      return 'php'
    case 'yml': case 'yaml':
      return 'yaml'
    case 'toml':
      return 'toml'
    case 'ini': case 'conf': case 'cfg':
      return 'ini'
    case 'sh': case 'bash': case 'zsh':
      return 'shellscript'
    case 'sql':
      return 'sql'
    case 'html': case 'htm': case 'vue': case 'svelte':
      return 'html'
    case 'xml': case 'svg':
      return 'xml'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'less':
      return 'less'
    case 'lua':
      return 'lua'
    default:
      return undefined
  }
}

/** One file-icon group: a colored badge with a short glyph label. */
export interface FileIconSpec {
  /** Label drawn inside the badge. */
  glyph: string
  /** CSS class of the badge color (FileIcon.module.css). */
  color: 'blue' | 'amber' | 'green' | 'red' | 'neutral'
}

/** Extension → icon group; unknown and extension-less names fall back to the neutral text badge. */
const FILE_ICON_BY_EXTENSION = new Map<string, FileIconSpec>([
  ['ts', { glyph: 'TS', color: 'blue' }],
  ['tsx', { glyph: 'TS', color: 'blue' }],
  ['js', { glyph: 'JS', color: 'blue' }],
  ['jsx', { glyph: 'JS', color: 'blue' }],
  ['mjs', { glyph: 'JS', color: 'blue' }],
  ['cjs', { glyph: 'JS', color: 'blue' }],
  ['json', { glyph: '{ }', color: 'amber' }],
  ['jsonc', { glyph: '{ }', color: 'amber' }],
  ['md', { glyph: 'M↓', color: 'neutral' }],
  ['mdx', { glyph: 'M↓', color: 'neutral' }],
  ['css', { glyph: '#', color: 'red' }],
  ['scss', { glyph: '#', color: 'red' }],
  ['less', { glyph: '#', color: 'red' }],
  ['html', { glyph: '<>', color: 'green' }],
  ['htm', { glyph: '<>', color: 'green' }],
  ['vue', { glyph: '<>', color: 'green' }],
  ['svelte', { glyph: '<>', color: 'green' }],
  ['xml', { glyph: '<>', color: 'green' }],
  ['svg', { glyph: '<>', color: 'green' }],
  ['sh', { glyph: '>_', color: 'green' }],
  ['bash', { glyph: '>_', color: 'green' }],
  ['zsh', { glyph: '>_', color: 'green' }],
  ['py', { glyph: 'PY', color: 'blue' }],
  ['go', { glyph: 'GO', color: 'blue' }],
  ['rs', { glyph: 'RS', color: 'amber' }],
  ['java', { glyph: 'JA', color: 'red' }],
  ['c', { glyph: 'C', color: 'neutral' }],
  ['cpp', { glyph: 'C++', color: 'blue' }],
  ['cs', { glyph: 'C#', color: 'green' }],
  ['kt', { glyph: 'KT', color: 'amber' }],
  ['swift', { glyph: 'SW', color: 'amber' }],
  ['php', { glyph: 'PHP', color: 'blue' }],
  ['yml', { glyph: 'YML', color: 'neutral' }],
  ['yaml', { glyph: 'YML', color: 'neutral' }],
  ['toml', { glyph: 'TOML', color: 'neutral' }],
  ['ini', { glyph: 'INI', color: 'neutral' }],
  ['conf', { glyph: 'INI', color: 'neutral' }],
  ['cfg', { glyph: 'INI', color: 'neutral' }],
  ['env', { glyph: 'ENV', color: 'amber' }],
  ['sql', { glyph: 'SQL', color: 'neutral' }],
  ['lua', { glyph: 'LUA', color: 'neutral' }],
  ['png', { glyph: 'IMG', color: 'neutral' }],
  ['jpg', { glyph: 'IMG', color: 'neutral' }],
  ['jpeg', { glyph: 'IMG', color: 'neutral' }],
  ['gif', { glyph: 'IMG', color: 'neutral' }],
  ['webp', { glyph: 'IMG', color: 'neutral' }],
  ['svgz', { glyph: 'IMG', color: 'neutral' }],
  ['txt', { glyph: 'TXT', color: 'neutral' }],
  ['log', { glyph: 'LOG', color: 'neutral' }],
])

/** The fallback badge for extension-less or unknown names. */
const UNKNOWN_ICON: FileIconSpec = { glyph: 'TXT', color: 'neutral' }

/**
 * The icon spec for a file name.
 * @param name - file base name.
 * @returns the badge spec (falling back to the neutral text badge).
 */
export function fileIconOf(name: string): FileIconSpec {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return UNKNOWN_ICON
  return FILE_ICON_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? UNKNOWN_ICON
}
