/** Behavior of the file-browser service over a real temporary directory tree. */

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import FileBrowser, { boundedInsert, fullyQualified, raceAbort } from '../src/index.ts'
import type { ListingCandidate } from '../src/index.ts'

let root: string
let browser: FileBrowser
let dispose: () => Promise<void>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-file-browser-'))
  await mkdir(join(root, 'projects'))
  await mkdir(join(root, 'projects', 'harness'))
  await mkdir(join(root, '.hidden-dir'))
  await writeFile(join(root, 'notes.txt'), 'not a directory')
  await symlink(join(root, 'projects'), join(root, 'linked'), 'junction')
  await symlink(join(root, 'gone'), join(root, 'broken'), 'junction')
  try {
    await symlink(join(root, 'notes.txt'), join(root, 'file-link'))
  } catch {
    // Windows denies unprivileged file symlinks; the file-link row only
    // feeds the POSIX lanes' coverage of the symlink-to-file arm, and every
    // assertion below expects it to be filtered out anyway.
  }

  const ctx = new Context()
  const fiber = ctx.plugin(FileBrowser)
  await fiber.await()
  browser = ctx.get('fileBrowser')!
  dispose = () => fiber.dispose()
})

afterAll(async () => {
  await dispose()
  await rm(root, { recursive: true, force: true })
})

describe('FileBrowser', () => {
  it('lists files and directories, flags hidden rows, follows symlinks, skips broken links, sorts by name', async () => {
    const listing = await browser.list(root)
    expect(listing.path).toBe(root)
    expect(listing.home).toBe(homedir())
    const names = listing.entries.map(entry => entry.name)
    // Windows denies unprivileged file symlinks, so the file-link row only
    // exists on POSIX lanes.
    expect(names).toEqual(
      names.includes('file-link')
        ? ['.hidden-dir', 'file-link', 'linked', 'notes.txt', 'projects']
        : ['.hidden-dir', 'linked', 'notes.txt', 'projects'],
    )
    expect(listing.entries.map(entry => entry.hidden)).toEqual(names.map(name => name.startsWith('.')))
    const kindOf = (name: string): string | undefined => listing.entries.find(entry => entry.name === name)?.kind
    expect(kindOf('.hidden-dir')).toBe('directory')
    expect(kindOf('linked')).toBe('directory')
    expect(kindOf('projects')).toBe('directory')
    expect(kindOf('notes.txt')).toBe('file')
    // Every entry path is absolute and host-joined — clients never join segments.
    expect(listing.entries.every(entry => entry.path === join(root, entry.name))).toBe(true)
    // Well under the default bound: the complete level, not a cut one.
    expect(listing.truncated).toBe(false)
  })

  it('cuts a level at maxEntries keeping the name-sorted head, and flags the cut', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(FileBrowser, { maxEntries: 1, maxReadBytes: 64 })
    await fiber.await()
    const bounded = ctx.get('fileBrowser')!
    try {
      const cut = await bounded.list(root)
      expect(cut.entries.map(entry => entry.name)).toEqual(['.hidden-dir'])
      expect(cut.truncated).toBe(true)
      // Exactly at the bound is complete, not truncated.
      const exact = await bounded.list(join(root, 'projects'))
      expect(exact.entries.map(entry => entry.name)).toEqual(['harness'])
      expect(exact.truncated).toBe(false)
      // A level that fits the window but exceeds the bound (two rows, bound
      // one): the in-window extra row proves the cut without any eviction.
      await mkdir(join(root, 'projects', 'harness', 'a'))
      await mkdir(join(root, 'projects', 'harness', 'b'))
      const inWindow = await bounded.list(join(root, 'projects', 'harness'))
      expect(inWindow.entries.map(entry => entry.name)).toEqual(['a'])
      expect(inWindow.truncated).toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('stops the scan with the caller: an aborted signal rejects with its own reason', async () => {
    const gone = new AbortController()
    gone.abort(new Error('caller left'))
    // The abort surfaces as-is, not dressed as an unreadable directory —
    // and rejects even before any level row is read.
    await expect(browser.list(root, gone.signal)).rejects.toThrow('caller left')
    // The abandoned open that still succeeds is closed, not leaked.
    await new Promise(resolve => setTimeout(resolve, 10))
    // Aborted against a missing target: the abandoned open rejects on its
    // own and there is nothing to close.
    await expect(browser.list(join(root, 'no-such-dir'), gone.signal)).rejects.toThrow('caller left')
    await new Promise(resolve => setTimeout(resolve, 10))
    // A live signal leaves a normal listing untouched — the reads and the
    // symlink probes race it without ever losing.
    const live = new AbortController()
    const complete = await browser.list(root, live.signal)
    expect(complete.truncated).toBe(false)
    expect(complete.entries.map(entry => entry.name)).toContain('linked')
    // A live signal changes nothing about ordinary failures.
    const missing = join(root, 'no-such-dir')
    const failure = await browser.list(missing, live.signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
  })

  it('raceAbort follows the operation until the signal wins, and swallows the abandoned settlement', async () => {
    // No signal / settled operations: plain passthrough, listener removed.
    await expect(raceAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok')
    const live = new AbortController()
    await expect(raceAbort(Promise.resolve('ok'), live.signal)).resolves.toBe('ok')
    // Failure passthrough keeps the operation's own error.
    await expect(raceAbort(Promise.reject(new Error('raw failure')), live.signal)).rejects.toThrow('raw failure')
    // The abort wins over a pending operation and carries its own reason;
    // the operation's late rejection is swallowed, never unhandled.
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let rejectLate!: (reason: unknown) => void
      const pending = new Promise<never>((_resolve, reject) => { rejectLate = reject })
      const controller = new AbortController()
      const raced = raceAbort(pending, controller.signal)
      // A bare-string abort reason exercises the Error wrap.
      controller.abort('caller left')
      await expect(raced).rejects.toThrow('caller left')
      rejectLate(new Error('late read failure'))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('boundedInsert keeps the window name-sorted and bounded, reporting evictions', () => {
    const candidate = (name: string): ListingCandidate => ({ name, isDirectory: true, isSymbolicLink: false })
    const window: ListingCandidate[] = []
    expect(boundedInsert(window, candidate('m'), 2)).toBe(false)
    expect(boundedInsert(window, candidate('z'), 2)).toBe(false)
    // A smaller name lands in place and pushes the current largest out.
    expect(boundedInsert(window, candidate('a'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    // A name at or beyond the full window's tail rejects on one comparison.
    expect(boundedInsert(window, candidate('t'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    expect(boundedInsert(window, candidate('m'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
  })

  it('reports the ancestry as jump-target crumbs ending at the listed directory', async () => {
    const listing = await browser.list(join(root, 'projects'))
    const tail = listing.crumbs.at(-1)!
    expect(tail).toMatchObject({ name: 'projects', path: join(root, 'projects'), hidden: false })
    expect(listing.crumbs.at(-2)!.path).toBe(root)
    expect(listing.crumbs.at(-2)!.name).toBe(basename(root))
    // The chain starts at the filesystem root, whose crumb is labeled by its full path.
    expect(listing.crumbs[0]!.name).toBe(listing.crumbs[0]!.path)
  })

  it('lists the home directory when no path is given', async () => {
    const listing = await browser.list()
    expect(listing.path).toBe(homedir())
  })

  it('throws directory-unreadable for a missing target', async () => {
    const missing = join(root, 'no-such-dir')
    const failure = await browser.list(missing).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
    expect((failure as DirectoryPickerError).path).toBe(missing)
  })

  it('classifies fully qualified paths per platform (drive-less rooted Windows forms rejected)', () => {
    expect(fullyQualified('/home/x', 'linux')).toBe(true)
    expect(fullyQualified('x/y', 'darwin')).toBe(false)
    expect(fullyQualified('C:\\projects', 'win32')).toBe(true)
    expect(fullyQualified('C:/projects', 'win32')).toBe(true)
    expect(fullyQualified('\\\\server\\share', 'win32')).toBe(true)
    expect(fullyQualified('//server/share/deep', 'win32')).toBe(true)
    // Rooted but drive-less: isAbsolute accepts these, yet resolve() would
    // inject the process's current drive.
    expect(fullyQualified('\\foo', 'win32')).toBe(false)
    expect(fullyQualified('/foo', 'win32')).toBe(false)
    expect(fullyQualified('C:relative', 'win32')).toBe(false)
    // Incomplete UNC prefixes collapse to drive-relative roots under resolve().
    expect(fullyQualified('\\\\', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server\\', 'win32')).toBe(false)
  })

  it('rejects non-absolute paths instead of rebasing them under the process cwd', async () => {
    for (const relative of ['', 'projects', './projects', '..']) {
      const listFailure = await browser.list(relative).catch((error: unknown) => error)
      expect(listFailure).toBeInstanceOf(DirectoryPickerError)
      expect((listFailure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((listFailure as DirectoryPickerError).path).toBe(relative)
      const createFailure = await browser.createDirectory(relative, 'child').catch((error: unknown) => error)
      expect(createFailure).toBeInstanceOf(DirectoryPickerError)
      expect((createFailure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((createFailure as DirectoryPickerError).path).toBe(relative)
    }
  })

  it('creates one child directory and surfaces it in the next listing', async () => {
    const created = await browser.createDirectory(root, 'fresh')
    expect(created).toBe(join(root, 'fresh'))
    const listing = await browser.list(root)
    expect(listing.entries.map(entry => entry.name)).toContain('fresh')
  })

  it('refuses an existing child with directory-exists', async () => {
    const failure = await browser.createDirectory(root, 'projects').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-exists')
  })

  it('refuses non-segment names and other filesystem failures with directory-create-failed', async () => {
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b']) {
      const failure = await browser.createDirectory(root, name).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
    }
    // Missing parent is a real failure, not a level to invent.
    const missingParent = await browser.createDirectory(join(root, 'no-such-dir'), 'child').catch((error: unknown) => error)
    expect((missingParent as DirectoryPickerError).code).toBe('directory-create-failed')
  })

  it('reads a regular text file whole', async () => {
    const content = await browser.readFile(join(root, 'notes.txt'))
    expect(content).toBe('not a directory')
  })

  it('rejects non-regular files and unreadable targets with file-unreadable', async () => {
    // A directory is not a readable text file.
    const directoryRead = await browser.readFile(join(root, 'projects')).catch((error: unknown) => error)
    expect(directoryRead).toBeInstanceOf(DirectoryPickerError)
    expect((directoryRead as DirectoryPickerError).code).toBe('file-unreadable')
    // Relative paths must never rebase under the process cwd.
    const relativeRead = await browser.readFile('notes.txt').catch((error: unknown) => error)
    expect(relativeRead).toBeInstanceOf(DirectoryPickerError)
    expect((relativeRead as DirectoryPickerError).code).toBe('file-unreadable')
    // A missing target is unreadable, not a different business code.
    const missingRead = await browser.readFile(join(root, 'no-such-file')).catch((error: unknown) => error)
    expect(missingRead).toBeInstanceOf(DirectoryPickerError)
    expect((missingRead as DirectoryPickerError).code).toBe('file-unreadable')
  })

  it('refuses a file beyond the read bound with file-too-large', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(FileBrowser, { maxEntries: 1000, maxReadBytes: 4 })
    await fiber.await()
    const bounded = ctx.get('fileBrowser')!
    try {
      const failure = await bounded.readFile(join(root, 'notes.txt')).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('file-too-large')
      // Exactly at the bound reads whole.
      const exact = join(root, 'bound.txt')
      await writeFile(exact, '1234')
      expect(await bounded.readFile(exact)).toBe('1234')
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects binary content with file-not-text', async () => {
    const binary = join(root, 'binary.bin')
    await writeFile(binary, Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const failure = await browser.readFile(binary).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('file-not-text')
  })

  it('stops the read with the caller: an aborted signal rejects with its own reason', async () => {
    const gone = new AbortController()
    gone.abort(new Error('caller left'))
    await expect(browser.readFile(join(root, 'notes.txt'), gone.signal)).rejects.toThrow('caller left')
    // The abandoned open that still succeeds is closed, not leaked.
    await new Promise(resolve => setTimeout(resolve, 10))
    // A live signal leaves a normal read untouched.
    const live = new AbortController()
    await expect(browser.readFile(join(root, 'notes.txt'), live.signal)).resolves.toBe('not a directory')
  })

  it('replaces a text file atomically and surfaces it in the next read and listing', async () => {
    const target = join(root, 'notes.txt')
    await browser.writeFile(target, 'edited content')
    await expect(browser.readFile(target)).resolves.toBe('edited content')
    // The write creates a file and leaves no temp siblings behind.
    const listing = await browser.list(root)
    expect(listing.entries.map(entry => entry.name)).toContain('notes.txt')
    const siblings = await readdir(root)
    expect(siblings.filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('rejects non-fully-qualified writes with file-write-failed', async () => {
    for (const relative of ['notes.txt', 'sub/dir/x.ts', '..']) {
      const failure = await browser.writeFile(relative, 'x').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('file-write-failed')
      expect((failure as DirectoryPickerError).path).toBe(relative)
    }
  })

  it('reports a filesystem write failure with file-write-failed', async () => {
    // Writing through a path whose parent is a FILE fails under the atomic
    // temp sibling (the mkdir parent step is recursive, so use a read-only
    // trick: a parent path nested under a regular file).
    const blocked = join(root, 'notes.txt', 'child.ts')
    const failure = await browser.writeFile(blocked, 'x').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('file-write-failed')
  })
})
