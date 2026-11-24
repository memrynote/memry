/**
 * On Windows the vault watcher holds every directory it watches open, so a
 * folder with a subfolder never renames in one step and `moveDirectory` moves
 * it entry by entry through a hidden staging directory. The watcher sees each
 * file leave long before the folder reappears, and an unlink that outlived the
 * rename window was taken for a delete: the note's doc was purged, its delete
 * synced to every device, and the next open indexed the file again under a new
 * id (#5695).
 *
 * Driven through the real `notes:rename-folder` handler, file-backed
 * databases, the projection runtime and the real watcher. `fs/promises`
 * refuses to rename a watched directory that holds a subdirectory, as Windows
 * does, so the real fallback runs. The fallback pauses after its first files
 * until their unlinks are past the rename window, which a few hundred notes on
 * a Windows machine reach without help.
 *
 * @module vault/folder-rename-fallback.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type * as PromisesModule from 'fs/promises'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { NotesChannels } from '@memry/contracts/notes-api'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { invokeHandler, mockIpcMain } from '@tests/utils/mock-ipc'

const fsHooks = vi.hoisted(() => ({
  /** Runs before every `fs/promises` rename the app makes. */
  beforeRename: null as null | ((from: string, to: string) => Promise<void>),
  /** Runs after every `fs/promises` rm the app makes. */
  afterRm: null as null | (() => Promise<void>)
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof PromisesModule>()
  const rename = async (from: string, to: string): Promise<void> => {
    await fsHooks.beforeRename?.(from, to)
    return actual.rename(from, to)
  }
  const rm: typeof actual.rm = async (...args) => {
    await actual.rm(...args)
    await fsHooks.afterRm?.()
  }
  return { ...actual, default: { ...actual, rename, rm }, rename, rm }
})
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: mockIpcMain,
  net: { fetch: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() }
}))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  updateFtsContent: vi.fn()
}))
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))
vi.mock('./status', async () => await import('./index'))
vi.mock('./index', () => ({
  emitIndexProgress: vi.fn(),
  getConfig: vi.fn(() => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  })),
  getStatus: vi.fn()
}))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))
vi.mock('../sync/crdt-provider', () => {
  const stub = {
    initForNote: vi.fn(async () => {}),
    updateMeta: vi.fn(),
    getDoc: () => undefined,
    recordOwedFullState: vi.fn(),
    hasPersistence: () => true,
    awaitPendingInit: async () => {},
    readOnlyStore: () => ({ docNames: async () => [], updates: async () => [] }),
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    open: vi.fn(async () => undefined),
    withDocLoaded: vi.fn(async (_id: string, run: () => void) => run()),
    closeIfInactive: async () => {},
    whenPersisted: async () => {},
    purge: vi.fn(async () => {})
  }
  return { ORIGIN_LOCAL: 'local', getCrdtProvider: vi.fn(() => stub) }
})
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => 0)
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))

import { getDatabase, getIndexDatabase } from '../database'
import {
  getDatabase as getClientDatabase,
  getIndexDatabase as getClientIndexDatabase
} from '../database/client'
import { getStatus } from './index'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { getCrdtProvider } from '../sync/crdt-provider'
import { registerNotesHandlers } from '../ipc/notes-handlers'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { indexVault } from './indexer'
import { recoverStrandedFolderMoves } from './move-directory'
import { clearAllPendingDeletes, getPendingDeleteCount } from './rename-tracker'
import { getWatcher, startWatcher, stopWatcher } from './watcher'

/** Past the 500 ms rename window, with room for the decision's disk check. */
const PAST_RENAME_WINDOW_MS = 1500

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('a folder rename that moves entry by entry (#5695)', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  const abs = (relativePath: string): string => path.join(vault.path, relativePath)
  const isHidden = (absolutePath: string): boolean =>
    path
      .relative(vault.path, absolutePath)
      .split(path.sep)
      .some((segment) => segment.startsWith('.'))

  function openDatabases(): void {
    data = createTestDataDb(path.join(vault.memryDir, 'data.db'))
    index = createTestIndexDb(path.join(vault.memryDir, 'index.db'))
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getClientDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getClientIndexDatabase).mockReturnValue(index.db)
  }

  async function openVault(): Promise<void> {
    openDatabases()
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
    await startWatcher(vault.path)
    // The open order of `runBackgroundIndexBuild`: recover, replay, walk.
    await recoverStrandedFolderMoves(vault.path)
    await getWatcher().replayMissedRemovals()
    await indexVault(vault.path)
    await settle()
  }

  async function closeVault(): Promise<void> {
    await stopWatcher()
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    index.close()
    data.close()
  }

  async function settle(): Promise<void> {
    await sleep(PAST_RENAME_WINDOW_MS)
    await flushProjectionEvents()
    await drainIngestBackfill()
    await flushProjectionEvents()
  }

  /** `count` notes spread over a folder, its subfolder and that one's subfolder. */
  function writeNotes(folder: string, count: number): string[] {
    const paths = Array.from({ length: count }, (_, i) => {
      const depth = ['', 'Sub/', 'Sub/Deeper/'][i % 3]
      return `${folder}/${depth}Note ${i}.md`
    })
    for (const relativePath of paths) {
      fs.mkdirSync(path.dirname(abs(relativePath)), { recursive: true })
      fs.writeFileSync(abs(relativePath), `# ${path.basename(relativePath)}\n\nbody\n`)
    }
    return paths
  }

  /** Every note row as `path -> id`, from the canonical and the index row. */
  function rowsByPath(): { canonical: Map<string, string>; indexed: Map<string, string> } {
    const select = { id: noteMetadata.id, path: noteMetadata.path }
    return {
      canonical: new Map(
        data.db
          .select(select)
          .from(noteMetadata)
          .all()
          .map((row) => [row.path, row.id])
      ),
      indexed: new Map(
        index.db
          .select({ id: noteCache.id, path: noteCache.path })
          .from(noteCache)
          .all()
          .map((row) => [row.path, row.id])
      )
    }
  }

  const syncedNoteDeletes = (): unknown[] =>
    vi
      .mocked(enqueueLocalSyncDelete)
      .mock.calls.filter(([type]) => type === 'note')
      .map(([, id]) => id)

  /** Until the watcher's unlinks are tracked and past their rename window. */
  async function outlastRenameWindow(): Promise<void> {
    await vi.waitFor(() => expect(getPendingDeleteCount()).toBeGreaterThan(0), {
      timeout: 10_000
    })
    await sleep(PAST_RENAME_WINDOW_MS)
  }

  /**
   * Windows under the watcher: a watched directory holding a subdirectory
   * refuses to rename. Once `pauseAfter` notes have left for the staging
   * directory the move waits out the rename window and runs `duringPause`.
   * The note after `failAfter` cannot be moved, and one `stuck` names cannot
   * be moved back out of the staging directory either. From the rename
   * `crashAt` picks on, nothing renames at all: the app is gone, and neither
   * the move nor its undo reaches the disk again.
   */
  function emulateWindowsMove(script: {
    pauseAfter?: number
    duringPause?: () => unknown
    failAfter?: number
    stuck?: (name: string) => boolean
    crashAt?: (from: string) => boolean
  }): void {
    let moved = 0
    let crashed = false
    fsHooks.beforeRename = async (from, to) => {
      if (crashed || script.crashAt?.(from)) {
        crashed = true
        throw errno('EIO')
      }
      const stat = fs.statSync(from, { throwIfNoEntry: false })
      if (stat?.isDirectory() && !isHidden(from)) {
        const entries = fs.readdirSync(from, { withFileTypes: true })
        if (entries.some((entry) => entry.isDirectory())) throw errno('EPERM')
      }
      if (!from.endsWith('.md')) return
      const name = path.basename(from)
      if (isHidden(from) && !isHidden(to) && script.stuck?.(name)) throw errno('EIO')
      if (!isHidden(to)) return
      if (moved === script.failAfter) throw errno('EIO')
      if (++moved === script.pauseAfter) {
        await outlastRenameWindow()
        await script.duringPause?.()
      }
    }
  }

  const stagingDirs = (): string[] =>
    fs.readdirSync(vault.path).filter((name) => name.startsWith('.memry-move-'))
  const moveRecords = (): string[] =>
    fs.existsSync(path.join(vault.memryDir, 'moves'))
      ? fs.readdirSync(path.join(vault.memryDir, 'moves'))
      : []

  async function renameFolder(oldPath: string, newPath: string): Promise<unknown> {
    return invokeHandler(NotesChannels.invoke.RENAME_FOLDER, { oldPath, newPath })
  }

  beforeEach(async () => {
    vault = createTestVault('folder-rename-fallback')
    vi.mocked(getStatus).mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    })
    registerNotesHandlers()
  })

  afterEach(async () => {
    fsHooks.afterRm = null
    fsHooks.beforeRename = null
    await closeVault()
    mockIpcMain._clearHandlers()
    vault.cleanup()
    vi.clearAllMocks()
  })

  it('keeps every note and its id however long the move takes', async () => {
    const paths = writeNotes('Big', 300)
    await openVault()
    const before = rowsByPath()
    expect(before.canonical.size).toBe(300)

    emulateWindowsMove({ pauseAfter: 20 })
    await expect(renameFolder('Big', 'Renamed')).resolves.toEqual({ success: true })
    await settle()

    expect(syncedNoteDeletes()).toEqual([])
    expect(getCrdtProvider().purge).not.toHaveBeenCalled()
    const expected = new Map(
      paths.map((p) => [`Renamed${p.slice('Big'.length)}`, before.canonical.get(p)])
    )
    expect(rowsByPath()).toEqual({ canonical: expected, indexed: expected })

    fsHooks.beforeRename = null
    await closeVault()
    await openVault()

    expect(syncedNoteDeletes()).toEqual([])
    expect(rowsByPath()).toEqual({ canonical: expected, indexed: expected })
  }, 60_000)

  it('deletes a note whose file is deleted outside the app before the move reaches it', async () => {
    const paths = writeNotes('Big', 60)
    await openVault()
    const before = rowsByPath().canonical
    let deleted = ''

    emulateWindowsMove({
      pauseAfter: 10,
      duringPause: () => {
        deleted = `Big/${fs.readdirSync(abs('Big')).find((name) => name.endsWith('.md'))}`
        fs.rmSync(abs(deleted))
      }
    })
    // The move meets the missing file and puts every entry back.
    await expect(renameFolder('Big', 'Renamed')).resolves.toMatchObject({ success: false })
    await settle()

    expect(syncedNoteDeletes()).toEqual([before.get(deleted)])
    const kept = new Map(paths.filter((p) => p !== deleted).map((p) => [p, before.get(p)]))
    expect(rowsByPath()).toEqual({ canonical: kept, indexed: kept })
  }, 60_000)

  it('deletes at the next open a note whose file is deleted outside the app mid-move', async () => {
    const paths = writeNotes('Big', 60)
    await openVault()
    const before = rowsByPath().canonical
    let deleted = ''

    emulateWindowsMove({
      pauseAfter: 10,
      duringPause: () => {
        const staging = fs.readdirSync(vault.path).find((name) => name.startsWith('.memry-move-'))!
        const name = fs.readdirSync(abs(staging)).find((entry) => entry.endsWith('.md'))!
        deleted = `Big/${name}`
        fs.rmSync(abs(`${staging}/${name}`))
      }
    })
    await expect(renameFolder('Big', 'Renamed')).resolves.toEqual({ success: true })
    await settle()
    fsHooks.beforeRename = null
    await closeVault()
    await openVault()

    expect(syncedNoteDeletes()).toEqual([before.get(deleted)])
    const kept = new Map(
      paths
        .filter((p) => p !== deleted)
        .map((p) => [`Renamed${p.slice('Big'.length)}`, before.get(p)])
    )
    expect(rowsByPath()).toEqual({ canonical: kept, indexed: kept })
  }, 60_000)

  it('keeps the notes a failed move could not put back, and puts them back at the next open', async () => {
    const paths = writeNotes('Big', 90)
    await openVault()
    const before = rowsByPath()

    emulateWindowsMove({
      pauseAfter: 30,
      failAfter: 45,
      stuck: (name) => /^Note \d*[05]\.md$/.test(name)
    })
    await expect(renameFolder('Big', 'Renamed')).resolves.toMatchObject({ success: false })
    await settle()

    expect(syncedNoteDeletes()).toEqual([])
    expect(getCrdtProvider().purge).not.toHaveBeenCalled()
    expect(rowsByPath()).toEqual(before)
    expect(paths.filter((p) => !fs.existsSync(abs(p))).length).toBeGreaterThan(0)

    fsHooks.beforeRename = null
    await closeVault()
    await openVault()

    expect(syncedNoteDeletes()).toEqual([])
    expect(rowsByPath()).toEqual(before)
    expect(paths.filter((p) => !fs.existsSync(abs(p)))).toEqual([])
    expect(fs.readdirSync(vault.path).filter((name) => name.startsWith('.memry-move-'))).toEqual([])
  }, 60_000)

  it('holds the deletes a rescan settles while the move runs', async () => {
    const paths = writeNotes('Big', 60)
    await openVault()
    const before = rowsByPath().canonical

    // The open's replay, or the rescan after the vault was away, finds the
    // moved files missing and settles their deletes with no rename window.
    emulateWindowsMove({ pauseAfter: 10, duringPause: () => getWatcher().replayMissedRemovals() })
    await expect(renameFolder('Big', 'Renamed')).resolves.toEqual({ success: true })
    await settle()

    expect(syncedNoteDeletes()).toEqual([])
    const expected = new Map(paths.map((p) => [`Renamed${p.slice('Big'.length)}`, before.get(p)]))
    expect(rowsByPath()).toEqual({ canonical: expected, indexed: expected })
  }, 60_000)

  // Before the move's last step, the staging directory's rename, the rows
  // still name the old paths, so the next open moves every file back there.
  it.each([
    {
      state: 'inside a split subfolder',
      crashAt: () => {
        let moved = 0
        return (from: string) =>
          path.dirname(from) === abs('Big/Sub') && from.endsWith('.md') && ++moved === 10
      },
      split: true,
      targetTaken: false
    },
    {
      state: 'at the staging directory rename',
      crashAt: () => (from: string) => path.basename(from).startsWith('.memry-move-'),
      split: false,
      targetTaken: false
    },
    {
      state: 'inside a split subfolder, with its target folder made since',
      crashAt: () => {
        let moved = 0
        return (from: string) =>
          path.dirname(from) === abs('Big/Sub') && from.endsWith('.md') && ++moved === 10
      },
      split: true,
      targetTaken: true
    }
  ])(
    'rolls back at the next open a move a crash stopped $state',
    async (scenario) => {
      const paths = writeNotes('Big', 90)
      await openVault()
      const before = rowsByPath()

      emulateWindowsMove({ crashAt: scenario.crashAt() })
      await expect(renameFolder('Big', 'Renamed')).resolves.toMatchObject({ success: false })
      await settle()
      expect(syncedNoteDeletes()).toEqual([])
      const [staging] = stagingDirs()
      const notesIn = (folder: string): number =>
        fs.existsSync(abs(folder))
          ? fs.readdirSync(abs(folder)).filter((name) => name.endsWith('.md')).length
          : 0
      // Split: the subfolder is half in its folder, half in the staging
      // directory. At the staging rename every note is staged.
      expect([notesIn('Big/Sub') > 0, notesIn(`${staging}/Sub`) > 0]).toEqual(
        scenario.split ? [true, true] : [false, true]
      )

      fsHooks.beforeRename = null
      await closeVault()
      if (scenario.targetTaken) {
        fs.mkdirSync(abs('Renamed'))
        fs.writeFileSync(abs('Renamed/Other.md'), '# Other\n')
      }
      await openVault()

      expect(syncedNoteDeletes()).toEqual([])
      expect(getCrdtProvider().purge).not.toHaveBeenCalled()
      expect(paths.filter((p) => !fs.existsSync(abs(p)))).toEqual([])
      expect(stagingDirs()).toEqual([])
      expect(moveRecords()).toEqual([])
      const after = rowsByPath()
      for (const [p, id] of before.canonical) {
        expect([after.canonical.get(p), after.indexed.get(p)]).toEqual([id, id])
      }
      const other = abs('Renamed/Other.md')
      expect(fs.existsSync(other) ? fs.readFileSync(other, 'utf8') : null).toBe(
        scenario.targetTaken ? '# Other\n' : null
      )
      expect(fs.existsSync(abs('Renamed'))).toBe(scenario.targetTaken)
    },
    60_000
  )

  it('rolls forward at the next open a move that ended before its record went', async () => {
    const paths = writeNotes('Big', 60)
    await openVault()
    const before = rowsByPath().canonical
    await closeVault()

    // A crash right after the staging directory became the folder: the files
    // are at the new path, the rows at the old one, and the record is left.
    fs.renameSync(abs('Big'), abs('Renamed'))
    fs.mkdirSync(path.join(vault.memryDir, 'moves'))
    fs.writeFileSync(
      path.join(vault.memryDir, 'moves/0123456789ab.json'),
      '{"version":1,"from":"Big","staging":".memry-move-0123456789ab"}'
    )
    await openVault()

    expect(syncedNoteDeletes()).toEqual([])
    expect(moveRecords()).toEqual([])
    const expected = new Map(paths.map((p) => [`Renamed${p.slice('Big'.length)}`, before.get(p)]))
    expect(rowsByPath()).toEqual({ canonical: expected, indexed: expected })
  }, 60_000)

  it('still deletes every note of a folder the app deletes, once the delete ends', async () => {
    writeNotes('Gone', 30)
    await openVault()
    const ids = [...rowsByPath().canonical.values()].toSorted()

    fsHooks.afterRm = outlastRenameWindow
    await expect(invokeHandler(NotesChannels.invoke.DELETE_FOLDER, 'Gone')).resolves.toEqual({
      success: true
    })
    fsHooks.afterRm = null
    await settle()

    expect(syncedNoteDeletes().map(String).toSorted()).toEqual(ids)
    expect(rowsByPath()).toEqual({ canonical: new Map(), indexed: new Map() })
  }, 60_000)
})
