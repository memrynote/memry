/**
 * A vault that goes away for a moment (drive unplugged, folder renamed) makes
 * chokidar report every file as unlinked. None of that may become a delete,
 * and the vault is rescanned once it is back (#2785).
 *
 * @module vault/watcher-vault-reachability.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { createTestVault } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'

const mocks = vi.hoisted(() => ({ watch: vi.fn() }))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))
vi.mock('chokidar', () => ({ default: { watch: mocks.watch }, watch: mocks.watch }))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  updateFtsContent: vi.fn()
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  enqueueJournalDelete: vi.fn(),
  initializeJournalCrdt: vi.fn()
}))
vi.mock('../notes/runtime-effects', () => ({
  syncNoteCreate: vi.fn(),
  syncNoteDelete: vi.fn(),
  syncNoteUpdate: vi.fn(),
  unlinkTasksFromDeletedNote: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn()
}))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => {}) }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => {})
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('./index', () => ({
  getConfig: () => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  })
}))

import { getDatabase, getIndexDatabase } from '../database'
import { enqueueJournalDelete } from '../journal/runtime-effects'
import { syncNoteDelete } from '../notes/runtime-effects'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { flushProjectionEvents, startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { clearIngestBackfill } from './ingest-backfill'
import { clearAllPendingDeletes } from './rename-tracker'
import { VaultWatcher } from './watcher'

interface WatcherInternals {
  vaultPath: string | null
  handleFileDelete(p: string): void
}

function fakeChokidar(): { close: ReturnType<typeof vi.fn> } {
  const fake = {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'ready') handler()
      return fake
    }),
    once: vi.fn(() => fake),
    close: vi.fn(async () => {})
  }
  return fake
}

describe('watcher and an unreachable vault (#2785)', () => {
  let vault: ReturnType<typeof createTestVault>
  let away: string
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let watcher: VaultWatcher

  const internals = (): WatcherInternals => watcher as unknown as WatcherInternals
  const abs = (relativePath: string): string => path.join(vault.path, relativePath)
  const row = (id: string) =>
    index.db.select().from(noteCache).where(eq(noteCache.id, id)).get() ?? null

  function seedNote(id: string, relativePath: string, date: string | null = null): void {
    fs.mkdirSync(path.dirname(abs(relativePath)), { recursive: true })
    fs.writeFileSync(abs(relativePath), `${id} text\n`)
    fs.utimesSync(abs(relativePath), new Date('2026-01-01'), new Date('2026-01-01'))
    insertNoteCache(index.db, {
      id,
      path: relativePath,
      title: id,
      contentHash: `hash-${id}`,
      wordCount: 2,
      characterCount: 10,
      date,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    mocks.watch.mockImplementation(fakeChokidar)
    vault = createTestVault('watcher-reachability')
    away = `${vault.path}-away`
    fs.writeFileSync(path.join(vault.path, '.memry', 'data.db'), '')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(data.db as never)
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
    seedNote('note-kept', 'notes/kept.md')
    seedNote('note-edited', 'notes/edited.md')
    seedNote('note-gone', 'notes/gone.md')
    seedNote('journal-day', 'journal/2026-05-10.md', '2026-05-10')
    watcher = new VaultWatcher()
    await watcher.start({ vaultPath: vault.path })
  })

  afterEach(async () => {
    await watcher.stop()
    await stopProjectionRuntime({ drain: true })
    clearAllPendingDeletes()
    clearIngestBackfill()
    if (fs.existsSync(away)) fs.rmSync(away, { recursive: true, force: true })
    data.close()
    index.close()
    vault.cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  function unlinkEverything(): void {
    for (const relativePath of [
      'notes/kept.md',
      'notes/edited.md',
      'notes/gone.md',
      'journal/2026-05-10.md'
    ]) {
      internals().handleFileDelete(abs(relativePath))
    }
  }

  it('queues no delete for files that vanish with the vault', async () => {
    fs.renameSync(vault.path, away)
    unlinkEverything()
    await vi.advanceTimersByTimeAsync(600)

    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(enqueueJournalDelete).not.toHaveBeenCalled()
    expect(row('note-kept')?.path).toBe('notes/kept.md')
    expect(row('journal-day')?.path).toBe('journal/2026-05-10.md')
  })

  it('queues no delete when the vault leaves inside the rename window', async () => {
    unlinkEverything()
    fs.renameSync(vault.path, away)
    await vi.advanceTimersByTimeAsync(600)

    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(enqueueJournalDelete).not.toHaveBeenCalled()
    expect(row('note-gone')?.path).toBe('notes/gone.md')
  })

  it('still syncs a delete for a file removed from a reachable vault', async () => {
    fs.rmSync(abs('notes/gone.md'))
    internals().handleFileDelete(abs('notes/gone.md'))
    await vi.advanceTimersByTimeAsync(600)
    await flushProjectionEvents()

    expect(syncNoteDelete).toHaveBeenCalledWith('note-gone')
    expect(syncNoteDelete).toHaveBeenCalledTimes(1)
    expect(row('note-gone')).toBeNull()
    expect(row('note-kept')?.path).toBe('notes/kept.md')
  })

  it('rescans the vault when it comes back and replays what changed meanwhile', async () => {
    fs.renameSync(vault.path, away)
    unlinkEverything()
    await vi.advanceTimersByTimeAsync(600)

    fs.writeFileSync(path.join(away, 'notes/edited.md'), 'edited while away\n')
    fs.utimesSync(path.join(away, 'notes/edited.md'), new Date(), new Date(Date.now() + 60_000))
    fs.rmSync(path.join(away, 'notes/gone.md'))
    fs.writeFileSync(path.join(away, 'notes/new.md'), 'new while away\n')
    fs.renameSync(away, vault.path)

    await vi.waitFor(
      () => {
        expect(syncNoteDelete).toHaveBeenCalledWith('note-gone')
        expect(row('note-edited')?.contentHash).not.toBe('hash-note-edited')
        expect(
          index.db.select().from(noteCache).where(eq(noteCache.path, 'notes/new.md')).get()
        ).toBeDefined()
      },
      { timeout: 10_000, interval: 100 }
    )

    expect(mocks.watch).toHaveBeenCalledTimes(2)
    expect(syncNoteDelete).toHaveBeenCalledTimes(1)
    expect(enqueueJournalDelete).not.toHaveBeenCalled()
    expect(row('note-kept')?.contentHash).toBe('hash-note-kept')
    expect(row('journal-day')?.path).toBe('journal/2026-05-10.md')
  })
})
