/**
 * A vault-wide tag rename, merge or delete over a note file swapped for a
 * symlink to a file outside the vault (#2936): the linked note is skipped and
 * logged, the outside text never lands in a vault file, and the other notes
 * still get the change. The vault and both databases are real.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { insertNoteCache, setNoteTags } from '@main/database/queries/notes'

const state = vi.hoisted(() => ({ data: null as unknown, index: null as unknown, vault: '' }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) =>
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    ),
    removeHandler: vi.fn((channel: string) => mockIpcMain.removeHandler(channel))
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))
vi.mock('../database', () => ({
  getIndexDatabase: () => state.index,
  getDatabase: () => state.data,
  requireDatabase: () => state.data
}))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => state.vault,
  toAbsolutePath: (p: string) => path.join(state.vault, p)
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../tags/runtime-effects', () => ({
  syncMergedTagDefinitions: vi.fn(),
  syncTaggedNote: vi.fn(),
  syncTagDefinitionDelete: vi.fn(),
  syncTagDefinitionRename: vi.fn(),
  syncTagDefinitionUpdate: vi.fn(),
  syncTagCategoryCreate: vi.fn(),
  syncTagCategoryUpdate: vi.fn(),
  syncTagCategoryDelete: vi.fn(),
  commitTaskRetag: vi.fn((_db: unknown, retag: () => unknown) => retag())
}))

import { registerTagsHandlers, unregisterTagsHandlers } from './tags-handlers'

const SECRET = '---\ntags: [old]\n---\nOutside secret\n'

describe('vault-wide tag changes and a note file linked outside the vault', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let outside: string
  let secret: string
  let link: string
  let free: string

  beforeEach(() => {
    resetIpcMocks()
    data = createTestDataDb()
    index = createTestIndexDb()
    state.data = data.db
    state.index = index.db
    state.vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tags-outside-link-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tags-outside-target-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, SECRET)
    fs.mkdirSync(path.join(state.vault, 'notes'))
    link = path.join(state.vault, 'notes', 'linked.md')
    fs.symlinkSync(secret, link)
    free = path.join(state.vault, 'notes', 'free.md')
    fs.writeFileSync(free, '---\ntags: [old]\n---\nFree body\n')
    for (const id of ['linked', 'free']) {
      insertNoteCache(index.db, {
        id,
        path: `notes/${id}.md`,
        title: id,
        contentHash: `hash-${id}`,
        wordCount: 0,
        characterCount: 0,
        createdAt: '2026-01-10T00:00:00.000Z',
        modifiedAt: '2026-01-12T00:00:00.000Z'
      })
      setNoteTags(index.db, id, ['old'])
    }
    registerTagsHandlers()
  })

  afterEach(() => {
    unregisterTagsHandlers()
    data.close()
    index.close()
    fs.rmSync(state.vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  function expectLinkUntouched(): void {
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET)
    expect(fs.readdirSync(path.join(state.vault, 'notes')).sort()).toEqual(['free.md', 'linked.md'])
  }

  it('rename skips the linked note and renames the tag in the free one', async () => {
    await invokeHandler(TagsChannels.invoke.RENAME_TAG, { oldName: 'old', newName: 'fresh' })

    expectLinkUntouched()
    expect(fs.readFileSync(free, 'utf-8')).toBe('---\ntags:\n  - fresh\n---\nFree body\n')
  })

  it('delete skips the linked note', async () => {
    await invokeHandler(TagsChannels.invoke.DELETE_TAG, 'old')

    expectLinkUntouched()
    expect(fs.readFileSync(free, 'utf-8')).not.toContain('old')
  })

  it('merge skips the linked note', async () => {
    await invokeHandler(TagsChannels.invoke.MERGE_TAG, { source: 'old', target: 'merged' })

    expectLinkUntouched()
    expect(fs.readFileSync(free, 'utf-8')).toContain('merged')
  })
})
