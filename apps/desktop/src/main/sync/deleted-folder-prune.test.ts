import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

let vaultPath = ''

vi.mock('../vault/index', () => ({
  getStatus: vi.fn(() => ({ path: vaultPath, isOpen: true }))
}))

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => logger
}))

const broadcastToAllWindows = vi.hoisted(() => vi.fn())
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows }))

import { folderConfigHandler } from './item-handlers/folder-config-handler'
import { scheduleDeletedFolderPrune } from './deleted-folder-prune'

function insertFolderRow(testDb: TestDatabaseResult, folderPath: string): void {
  testDb.db
    .insert(folderConfigs)
    .values({
      path: folderPath,
      icon: null,
      clock: { 'device-B': 1 },
      createdAt: '2026-09-20T00:00:00.000Z',
      modifiedAt: '2026-09-20T00:00:00.000Z'
    })
    .run()
}

function writeVaultFile(relPath: string, content = ''): void {
  const abs = path.join(vaultPath, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(vaultPath, relPath))
}

/** Apply a remote folder_config delete the way ItemApplier does: handler, then tombstone. */
function applyRemoteFolderDelete(ctx: ApplyContext, folderPath: string): string {
  const clock = { 'device-A': 1, 'device-B': 1 }
  const result = folderConfigHandler.applyDelete(ctx, folderPath, clock)
  recordTombstoneClock(ctx.db, 'folder_config', folderPath, clock)
  return result
}

describe('deleted folder prune (#2512)', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-folder-prune-'))
    testDb = createTestDataDb()
    ctx = { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
    vi.clearAllMocks()
  })

  afterEach(() => {
    testDb.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given an empty folder with subfolders #when the remote folder deletes arrive #then the folder is removed from disk', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'Archive'), { recursive: true })
    writeVaultFile('Projects/.folder.md', '---\nicon: x\n---\n')
    insertFolderRow(testDb, 'Projects')
    insertFolderRow(testDb, 'Projects/Archive')

    expect(applyRemoteFolderDelete(ctx, 'Projects')).toBe('applied')
    expect(applyRemoteFolderDelete(ctx, 'Projects/Archive')).toBe('applied')

    await vi.waitFor(() => expect(exists('Projects')).toBe(false))
    expect(broadcastToAllWindows).toHaveBeenCalledWith('notes:folder-config-updated', {
      path: 'Projects'
    })
  })

  it('#given the folder still holds a note #when the remote folder delete arrives #then the folder and the note stay and the reason is logged', async () => {
    writeVaultFile('Projects/plan.md', '# Plan')
    insertFolderRow(testDb, 'Projects')

    expect(applyRemoteFolderDelete(ctx, 'Projects')).toBe('applied')

    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        'Kept a folder deleted on another device, it still holds files',
        { folderPath: 'Projects', file: 'Projects/plan.md' }
      )
    )
    expect(exists('Projects/plan.md')).toBe(true)
  })

  it('#given the folder delete kept a folder with notes #when the last note delete lands #then the emptied folders are removed', async () => {
    writeVaultFile('Projects/Sub/plan.md', '# Plan')
    insertFolderRow(testDb, 'Projects')
    insertFolderRow(testDb, 'Projects/Sub')

    applyRemoteFolderDelete(ctx, 'Projects')
    applyRemoteFolderDelete(ctx, 'Projects/Sub')
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled())
    expect(exists('Projects/Sub/plan.md')).toBe(true)

    // The note's own remote delete: the note handler unlinks the file, then
    // schedules a prune of the note's folder.
    fs.unlinkSync(path.join(vaultPath, 'Projects/Sub/plan.md'))
    scheduleDeletedFolderPrune(ctx.db, 'Projects/Sub')

    await vi.waitFor(() => expect(exists('Projects')).toBe(false))
  })

  it('#given a note edited here stays in the deleted folder #when another note delete lands #then the folder is kept', async () => {
    writeVaultFile('Projects/old.md', '# Old')
    writeVaultFile('Projects/edited-here.md', '# Edited on this device')
    insertFolderRow(testDb, 'Projects')

    applyRemoteFolderDelete(ctx, 'Projects')
    fs.unlinkSync(path.join(vaultPath, 'Projects/old.md'))
    scheduleDeletedFolderPrune(ctx.db, 'Projects')

    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        'Kept a folder deleted on another device, it still holds files',
        { folderPath: 'Projects', file: 'Projects/edited-here.md' }
      )
    )
    expect(exists('Projects/edited-here.md')).toBe(true)
  })

  it('#given a folder that was never deleted remotely #when a note delete empties it #then the folder stays', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Inbox'), { recursive: true })

    scheduleDeletedFolderPrune(ctx.db, 'Inbox')
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(exists('Inbox')).toBe(true)
  })

  it('#given the folder has no local row #when the remote folder delete arrives #then the empty folder is still removed', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Unbacked'), { recursive: true })

    expect(applyRemoteFolderDelete(ctx, 'Unbacked')).toBe('skipped')

    await vi.waitFor(() => expect(exists('Unbacked')).toBe(false))
    expect(logger.info).toHaveBeenCalledWith('Remote folder config delete has no local row', {
      itemId: 'Unbacked'
    })
  })
})
