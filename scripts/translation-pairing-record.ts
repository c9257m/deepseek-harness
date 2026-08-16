/** Canonical paths, parsing, and rendering for bilingual pairing records. */

import { basename } from 'node:path'

/** The three repository-relative paths that form one bilingual pair. */
export interface TranslationPairPaths {
  /** English document path. */
  source: string
  /** Simplified Chinese document path. */
  zh: string
  /** Generated consistency-record path. */
  meta: string
}

/** The two content hashes recorded for a bilingual pair. */
export interface TranslationPairingRecord {
  /** Git blob hash of the English document. */
  sourceHash: string
  /** Git blob hash of the Simplified Chinese document. */
  zhHash: string
}

const META_LINE = /^([^:#]+\.md): ([0-9a-f]{40})$/

/**
 * Stems of reversed pairs. A reversed pair's unsuffixed `stem.md` is the
 * Simplified Chinese side (the default-displayed document, e.g. the root
 * README on GitHub) and its English side carries the `.en.md` suffix. Every
 * other pairing rule — the three-file triplet, the consistency record, the
 * switcher, and the structural signature — applies unchanged.
 */
const REVERSED_PAIR_STEMS: readonly string[] = ['README']

/** Whether a repository-relative path is the English side of a reversed pair. */
export function isReversedPairEnglish(file: string): boolean {
  return file.endsWith('.en.md') && REVERSED_PAIR_STEMS.includes(file.slice(0, -'.en.md'.length))
}

/** Whether a repository-relative path is the Chinese side of a reversed pair. */
export function isReversedPairZh(file: string): boolean {
  return file.endsWith('.md')
    && !file.endsWith('.zh.md')
    && !file.endsWith('.en.md')
    && REVERSED_PAIR_STEMS.includes(file.slice(0, -'.md'.length))
}

/**
 * Derive the three-path pair from any of its member spellings. In an
 * ordinary pair the input is the English `foo.md`; in a reversed pair it may
 * be the English `foo.en.md` or the unsuffixed Chinese `foo.md`. The return
 * value always keys the English path as `source`.
 *
 * @param member - Repository-relative English Markdown path, or the
 *   unsuffixed Chinese side of a reversed pair.
 * @returns The complete three-path pair.
 */
export function translationPairPaths(member: string): TranslationPairPaths {
  if (member.endsWith('.en.md')) {
    if (!isReversedPairEnglish(member)) {
      throw new Error(`expected a pair member path, received ${JSON.stringify(member)}`)
    }
    const stem = member.slice(0, -'.en.md'.length)
    return { source: member, zh: `${stem}.md`, meta: `${stem}.i18n.yaml` }
  }
  if (!member.endsWith('.md') || member.endsWith('.zh.md')) {
    throw new Error(`expected a pair member path, received ${JSON.stringify(member)}`)
  }
  if (isReversedPairZh(member)) {
    const stem = member.slice(0, -'.md'.length)
    return { source: `${stem}.en.md`, zh: member, meta: `${stem}.i18n.yaml` }
  }
  return {
    source: member,
    zh: member.replace(/\.md$/, '.zh.md'),
    meta: member.replace(/\.md$/, '.i18n.yaml'),
  }
}

/**
 * Derive one pair from its consistency-record path.
 *
 * @param meta - Repository-relative `foo.i18n.yaml` path.
 * @returns The complete three-path pair.
 */
export function translationPairPathsFromMeta(meta: string): TranslationPairPaths {
  if (!meta.endsWith('.i18n.yaml')) {
    throw new Error(`expected a bilingual consistency-record path, received ${JSON.stringify(meta)}`)
  }
  return translationPairPaths(meta.replace(/\.i18n\.yaml$/, '.md'))
}

/**
 * Parse a consistency record for its expected sibling names.
 *
 * @param content - Complete sidecar text.
 * @param paths - Expected sibling paths.
 * @returns The two hashes, or `undefined` for malformed, duplicate, or unexpected keys.
 */
export function parseTranslationPairingRecord(
  content: string,
  paths: TranslationPairPaths,
): TranslationPairingRecord | undefined {
  const hashes = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const match = META_LINE.exec(line)
    if (!match?.[1] || !match[2] || hashes.has(match[1])) return undefined
    hashes.set(match[1], match[2])
  }
  const sourceHash = hashes.get(basename(paths.source))
  const zhHash = hashes.get(basename(paths.zh))
  if (hashes.size !== 2 || sourceHash === undefined || zhHash === undefined) return undefined
  return { sourceHash, zhHash }
}

/**
 * Render the canonical consistency record for a pair.
 *
 * @param paths - Pair paths written into the record and its recovery command.
 * @param record - Confirmed content hashes.
 * @returns Canonical YAML text with exactly one trailing newline.
 */
export function renderTranslationPairingRecord(
  paths: TranslationPairPaths,
  record: TranslationPairingRecord,
): string {
  return [
    '# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each',
    '# side as of the last confirmed-consistent state. Both languages carry equal authority;',
    '# after editing either side, bring the other along and re-record with:',
    `#   pnpm run verify-translation-pairing --write ${paths.source}`,
    `${basename(paths.source)}: ${record.sourceHash}`,
    `${basename(paths.zh)}: ${record.zhHash}`,
    '',
  ].join('\n')
}
