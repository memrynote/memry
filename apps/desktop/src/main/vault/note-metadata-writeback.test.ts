/**
 * A note's tags or properties edit that lands while a write-back pass has read
 * the file and not yet written it (#5472). The pass writes back the
 * frontmatter it read, and the edit leaves the doc as it was, so the re-arm
 * after the pass cannot see it: the edit waits for the pass instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import type { NoteUpdateInput } from './notes-crud'
import type * as FileOps from './file-ops'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import * as vaultIndex from './status'
import * as database from '../database'
import * as databaseClient from '../database/client'
import { createNote, updateNote } from './notes'
import { hasPendingWriteback, resetWritebackState, writebackNow } from '../sync/crdt-writeback'
import { markdownToYFragment } from '../sync/blocknote-converter'
import { noteHandler } from '../sync/item-handlers/note-handler'
import { extractFolderFromPath } from '../sync/note-sync'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const hold = vi.hoisted(() => ({
  next: null as null | { reached: () => void; release: Promise<void> },
  /** The content of every file write that has landed. */
  landed: [] as string[]
}))

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return {
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
    BrowserWindow: { getAllWindows: vi.fn(() => [mockWindow]), fromId: () => null },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(() => Promise.resolve()) }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))
vi.mock('../notes/runtime-effects', () => ({ syncNoteUpdate: vi.fn() }))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
// The next file write waits here, after its writer read the file and built its bytes.
vi.mock('./file-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof FileOps>()
  return {
    ...actual,
    atomicWrite: async (...args: Parameters<typeof actual.atomicWrite>) => {
      const next = hold.next
      if (next) {
        hold.next = null
        next.reached()
        await next.release
      }
      await actual.atomicWrite(...args)
      hold.landed.push(args[1])
    }
  }
})

describe('a note tags or properties edit between a write-back read and write (#5472)', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('note-metadata-writeback')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)
    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(databaseClient, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(databaseClient, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    hold.next = null
    hold.landed = []
    resetWritebackState()
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  /** A pass holds at its file write; `edit` runs meanwhile. Resolves the file once both settle. */
  async function raceWithPass(
    edit: (note: { id: string; path: string }) => unknown,
    tags: string[] = []
  ): Promise<string> {
    const note = await createNote({ title: 'Race', content: 'Morning.', tags })
    const doc = new Y.Doc()
    await markdownToYFragment('Morning. Typed.', doc.getXmlFragment(CRDT_FRAGMENT_NAME), note.path)
    let release = (): void => {}
    const reached = new Promise<void>((resolve) => {
      hold.next = {
        reached: resolve,
        release: new Promise<void>((r) => {
          release = r
        })
      }
    })
    const writeback = writebackNow(note.id, doc)
    await reached
    const update = Promise.resolve(edit(note))
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await Promise.all([writeback, update])
    await vi.waitFor(() => expect(hasPendingWriteback(note.id)).toBe(false))
    return fs.readFileSync(path.join(vault.path, note.path), 'utf8')
  }

  it.each<[string, Omit<NoteUpdateInput, 'id'>, string]>([
    ['tags', { headerTags: { add: ['focus'] } }, '- focus'],
    ['properties', { properties: { mood: 'calm' } }, 'mood: calm']
  ])('the %s edit and the typed body both stay in the file', async (_n, edit, kept) => {
    const onDisk = await raceWithPass((note) => updateNote({ id: note.id, ...edit }))
    expect.soft(onDisk).toContain(kept)
    expect.soft(onDisk).toContain('Morning. Typed.')
  })

  // A body update writes its frontmatter beside the body, outside the turn.
  // The body comes back through the doc (feed, re-arm); the frontmatter only
  // through the update's own turn (#5479). The feed is stubbed here, so only
  // the frontmatter is asserted.
  it.each<[string, Omit<NoteUpdateInput, 'id'>, string]>([
    ['tags', { content: 'Morning. Typed. More.', headerTags: { add: ['focus'] } }, '- focus'],
    ['properties', { content: 'Morning. Typed. More.', properties: { mood: 'calm' } }, 'mood: calm']
  ])('a body update with %s keeps them in the file (#5479)', async (_n, edit, kept) => {
    const onDisk = await raceWithPass((note) => updateNote({ id: note.id, ...edit }))
    expect(onDisk).toContain(kept)
  })

  it('a remote tags update applied during the pass stays in the file (#5479)', async () => {
    const ctx: ApplyContext = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
    const clock = { 'device-remote': 1 }
    const onDisk = await raceWithPass((note) =>
      expect(
        noteHandler.applyUpsert(
          ctx,
          note.id,
          { tags: ['focus'], folderPath: extractFolderFromPath(note.path), clock },
          clock
        )
      ).toBe('applied')
    )
    expect.soft(onDisk).toContain('- focus')
    expect.soft(onDisk).toContain('Morning. Typed.')
  })

  // The remote patch lands right after the pass that put the old frontmatter
  // back, ahead of a local edit queued behind that pass, so the file holds the
  // remote record and the local edit on top of it, in either order (REVIEW-5482).
  const remoteTags = (note: { id: string; path: string }, tags = ['focus']): void => {
    const ctx: ApplyContext = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
    const clock = { 'device-remote': 1 }
    expect(
      noteHandler.applyUpsert(
        ctx,
        note.id,
        { tags, folderPath: extractFolderFromPath(note.path), clock },
        clock
      )
    ).toBe('applied')
  }
  const gap = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
  // A body update queues its frontmatter turn right after its write beside the
  // body lands, with no file I/O in between.
  const bodyWriteLanded = (body: string): Promise<void> =>
    vi.waitFor(() => expect(hold.landed.some((file) => file.includes(body))).toBe(true))

  it('a local tag edit queued before a remote tags update keeps both', async () => {
    const onDisk = await raceWithPass(async (note) => {
      const local = updateNote({ id: note.id, headerTags: { add: ['mine'] } })
      await gap()
      remoteTags(note)
      await local
    })
    expect.soft(onDisk).toContain('- mine')
    expect.soft(onDisk).toContain('- focus')
  })

  it('a local tag edit queued after a remote tags update keeps both', async () => {
    const onDisk = await raceWithPass(async (note) => {
      remoteTags(note)
      await gap()
      await updateNote({ id: note.id, headerTags: { add: ['mine'] } })
    })
    expect.soft(onDisk).toContain('- mine')
    expect.soft(onDisk).toContain('- focus')
  })

  // A body update writes its tag edit again in the note's turn, after the
  // remote patch. The edit, not the list it wrote outside the turn, so the tag
  // the remote removed stays removed (VERIFY-5482). Accepted limit: a remote
  // removal of the very tag the queued edit adds is undone; that needs the
  // add's push, the remote removal and its pull all inside one held pass.
  it.each([
    ['queued before', true],
    ['queued after', false]
  ])(
    'a body update with a tag add %s a remote tag removal keeps both edits',
    async (_n, localFirst) => {
      const onDisk = await raceWithPass(
        async (note) => {
          const local = (): Promise<unknown> =>
            updateNote({
              id: note.id,
              content: 'Morning. Typed. More.',
              headerTags: { add: ['mine'] }
            })
          if (localFirst) {
            const queued = local()
            await bodyWriteLanded('More.')
            remoteTags(note, ['keep'])
            await queued
          } else {
            remoteTags(note, ['keep'])
            await gap()
            await local()
          }
        },
        ['keep', 'stale']
      )
      expect.soft(onDisk).toContain('- mine')
      expect.soft(onDisk).toContain('- keep')
      expect.soft(onDisk).not.toContain('- stale')
    }
  )
})
