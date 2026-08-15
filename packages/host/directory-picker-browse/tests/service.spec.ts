/** Behavior of the browse backend as a thin delegation adapter over ctx.fileBrowser. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FileBrowser from '@deepseek-ai/dsh-host-file-browser'
import BrowseDirectoryPicker from '../src/index.ts'

let root: string
let dispose: () => Promise<void>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-browse-delegate-'))
  const ctx = new Context()
  const fileFiber = ctx.plugin(FileBrowser)
  await fileFiber.await()
  const browseFiber = ctx.plugin(BrowseDirectoryPicker)
  await browseFiber.await()
  dispose = async () => {
    await browseFiber.dispose()
    await fileFiber.dispose()
  }
})

afterAll(async () => {
  await dispose()
  await rm(root, { recursive: true, force: true })
})

describe('BrowseDirectoryPicker delegation', () => {
  it('delegates every primitive to ctx.fileBrowser', async () => {
    const ctx = new Context()
    const list = vi.fn(async () => ({
      path: root, home: root, crumbs: [], entries: [], truncated: false,
    }))
    const createDirectory = vi.fn(async () => join(root, 'fresh'))
    const readFile = vi.fn(async () => 'content')
    ctx.provide('fileBrowser', { list, createDirectory, readFile } as never)
    const fiber = ctx.plugin(BrowseDirectoryPicker)
    await fiber.await()
    const picked = ctx.get('directoryPicker')!.capability()
    try {
      if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
      const listing = await picked.list(root)
      expect(listing).toMatchObject({ path: root })
      expect(list).toHaveBeenCalledWith(root, undefined)
      await picked.createDirectory(root, 'fresh')
      expect(createDirectory).toHaveBeenCalledWith(root, 'fresh')
      await expect(picked.readFile(join(root, 'a.txt'))).resolves.toBe('content')
      expect(readFile).toHaveBeenCalledWith(join(root, 'a.txt'), undefined)
    } finally {
      await fiber.dispose()
    }
  })

  it('declares ctx.fileBrowser as a required service', () => {
    expect(BrowseDirectoryPicker.inject).toEqual(['fileBrowser'])
  })
})
