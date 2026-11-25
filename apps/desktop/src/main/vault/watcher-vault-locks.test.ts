/**
 * The watcher drops the echo of the app's own write (`fileHoldsAppWrite`). An
 * outside edit to a locked file made right after an app write is no echo and
 * must still get the locked text back (#2606).
 *
 * @module vault/watcher-vault-locks.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'

const mocks = vi.hoisted(() => ({
  restoreLockedNoteFile: vi.fn(async () => true),
  vaultPath: ''
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))
vi.mock('chokidar', () => ({ default: { watch: vi.fn() }, watch: vi.fn() }))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  updateFtsContent: vi.fn()
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../notes/runtime-effects', () => ({
  syncNoteCreate: vi.fn(),
  syncNoteDelete: vi.fn(),
  syncNoteUpdate: vi.fn(),
  unlinkTasksFromDeletedNote: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn()
}))
vi.mock('../vault-locks/service', () => ({ restoreLockedNoteFile: mocks.restoreLockedNoteFile }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('./status', async () => await import('./index'))
vi.mock('./index', () => ({
  getStatus: () => ({ path: mocks.vaultPath }),
  getConfig: () => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  })
}))

import { getDatabase, getIndexDatabase } from '../database'
import { installVaultLockSource, invalidateVaultLocks } from '../vault-locks/registry'
import { writeLockRow } from '../vault-locks/store'
import { recordAppWrite, resetAppWrites } from './app-writes'
import { VaultWatcher } from './watcher'

describe('watcher, app writes and read-only locks (#2606)', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  const paths: Record<string, string> = {
    'note-locked': 'notes/locked.md',
    'note-free': 'notes/free.md',
    'note-scan': 'sealed/scan.pdf'
  }

  const watcherFor = (): {
    handleFileAdd(p: string): Promise<void>
    handleFileChange(p: string): Promise<void>
  } => {
    const watcher = new VaultWatcher() as unknown as {
      vaultPath: string
      handleFileAdd(p: string): Promise<void>
      handleFileChange(p: string): Promise<void>
    }
    watcher.vaultPath = vault.path
    return watcher
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vault = createTestVault('watcher-locks')
    mocks.vaultPath = vault.path
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(data.db as never)
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    for (const [id, relativePath] of Object.entries(paths)) {
      fs.mkdirSync(path.dirname(path.join(vault.path, relativePath)), { recursive: true })
      fs.writeFileSync(path.join(vault.path, relativePath), 'synced text\n')
      insertNoteCache(index.db, {
        id,
        path: relativePath,
        title: id,
        contentHash: `hash-${id}`,
        wordCount: 0,
        characterCount: 0,
        createdAt: '2026-01-10T00:00:00.000Z',
        modifiedAt: '2026-01-12T00:00:00.000Z'
      })
    }
    installVaultLockSource({
      dataDb: () => asClientDb(data.db),
      notePathOf: (noteId) => paths[noteId] ?? null,
      noteIdAtPath: (relativePath) =>
        Object.keys(paths).find((id) => paths[id] === relativePath) ?? null
    })
    writeLockRow(asClientDb(data.db), 'note', 'note-locked', true)
    writeLockRow(asClientDb(data.db), 'folder', 'sealed', true)
    invalidateVaultLocks()
  })

  afterEach(() => {
    installVaultLockSource({ dataDb: () => null, notePathOf: () => null, noteIdAtPath: () => null })
    resetAppWrites()
    data.close()
    index.close()
    vault.cleanup()
  })

  function appWrites(file: string, bytes: string): void {
    const landed = recordAppWrite(file, bytes)
    fs.writeFileSync(file, bytes)
    landed()
  }

  it('restores a locked file edited from outside right after an app write', async () => {
    const file = path.join(vault.path, paths['note-locked'])
    appWrites(file, 'locked text\n')
    fs.writeFileSync(file, 'outside edit\n')

    await watcherFor().handleFileChange(file)

    expect(mocks.restoreLockedNoteFile).toHaveBeenCalledWith('note-locked', 'outside edit\n')
  })

  it("leaves the echo of a locked note's own write alone", async () => {
    const file = path.join(vault.path, paths['note-locked'])
    appWrites(file, 'locked text\n')

    await watcherFor().handleFileChange(file)

    expect(mocks.restoreLockedNoteFile).not.toHaveBeenCalled()
  })

  const isWritable = (file: string): boolean => (fs.statSync(file).mode & 0o200) !== 0

  it.skipIf(process.platform === 'win32')(
    'a file moved into a locked folder from outside becomes read-only',
    async () => {
      const moved = path.join(vault.path, 'sealed/moved-in.pdf')
      fs.writeFileSync(moved, 'pdf bytes')

      await watcherFor().handleFileAdd(moved)

      expect(isWritable(moved)).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'a locked file deleted and recreated outside the app is read-only again',
    async () => {
      const scan = path.join(vault.path, paths['note-scan'])
      fs.rmSync(scan)
      fs.writeFileSync(scan, 'recreated')

      await watcherFor().handleFileAdd(scan)
      expect(isWritable(scan)).toBe(false)

      fs.chmodSync(scan, 0o644)
      await watcherFor().handleFileChange(scan)
      expect(isWritable(scan)).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'a locked note renamed outside the app is read-only at its new name',
    async () => {
      const renamed = path.join(vault.path, 'notes/renamed.md')
      fs.renameSync(path.join(vault.path, paths['note-locked']), renamed)
      fs.chmodSync(renamed, 0o644)
      paths['note-locked'] = 'notes/renamed.md'

      try {
        await watcherFor().handleFileAdd(renamed)
      } finally {
        paths['note-locked'] = 'notes/locked.md'
      }

      expect(isWritable(renamed)).toBe(false)
    }
  )
})
