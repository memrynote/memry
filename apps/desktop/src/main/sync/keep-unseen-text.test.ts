import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { noteMetadata } from '@memry/db-schema/data-schema'
import type { VectorClock } from '@memry/contracts/sync-api'
import { SyncQueueManager } from '@memry/sync-client/queue'
import * as Y from 'yjs'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

// #3029: another device deletes a note or journal day while this device holds
// text it never received. The pulled delete still wins, but that text is kept
// as an inbox note first. Driven through ItemApplier and a page transaction,
// the path a pulled tombstone takes.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-unseen-text-'))
const vaultPath = path.join(root, 'vault')
const userDataDir = path.join(root, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const { currentDb, syncInboxCreate } = vi.hoisted(() => ({
  currentDb: { value: null as unknown },
  syncInboxCreate: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => userDataDir) } }))
vi.mock('../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})
vi.mock('./crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ purge: vi.fn(() => Promise.resolve()) })
}))
vi.mock('../projections', () => ({
  flushProjectionEvents: vi.fn(),
  publishProjectionEvent: vi.fn()
}))
vi.mock('../database/client', () => ({
  getDatabase: () => currentDb.value,
  getIndexDatabase: vi.fn(() => ({})),
  isIndexDatabaseInitialized: vi.fn(() => false),
  getRawIndexDatabase: vi.fn(() => null)
}))
vi.mock('../database', () => ({ getDatabase: () => currentDb.value }))
vi.mock('../notes/runtime-effects', () => ({
  cleanupProjectLinksForDeletedNote: vi.fn(() => Promise.resolve())
}))
vi.mock('../inbox/runtime-effects', () => ({ syncInboxCreate }))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => vaultPath,
  toRelativePath: (p: string) => path.relative(vaultPath, p),
  toAbsolutePath: (p: string) => path.join(vaultPath, p)
}))
vi.mock('../vault/index', () => ({
  getStatus: () => ({ path: vaultPath, isOpen: true }),
  getConfig: () => ({ journalFolder: 'journal', defaultNoteFolder: 'notes' })
}))

import { ItemApplier } from './apply-item'
import { beginPageApply, _resetBulkApplyForTests } from './bulk-apply'
import { recordNoteBodyPush } from './note-body-push-record'

const DATE = '2026-10-09'
const DAY = `j${DATE}`
const NOTE = 'abcdefghijkl'
// The deleting device's time, in the whole seconds desktop pushes.
const DELETED_MS = Date.parse(`${DATE}T12:00:00.000Z`)
const DELETED_S = DELETED_MS / 1000
const TOMBSTONE: VectorClock = { a: 5 }

const dayFile = path.join(vaultPath, 'journal', `${DATE}.md`)
const noteFile = path.join(vaultPath, 'notes', 'Plans.md')

describe('a pulled delete over text this device never sent (#3029)', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    vi.clearAllMocks()
    _resetBulkApplyForTests()
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.rmSync(path.join(userDataDir, 'sync-bulk-apply-journal.json'), { force: true })
    fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
    fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
    testDb = createTestDataDb()
    currentDb.value = testDb.db
  })

  afterEach(() => {
    _resetBulkApplyForTests()
    testDb.close()
  })

  const seedDay = (clock: VectorClock, body: string): void => {
    fs.writeFileSync(dayFile, body)
    testDb.db
      .insert(noteMetadata)
      .values({
        id: DAY,
        path: `journal/${DATE}.md`,
        title: DATE,
        fileType: 'markdown',
        journalDate: DATE,
        clock,
        createdAt: `${DATE}T08:00:00.000Z`,
        modifiedAt: `${DATE}T08:00:00.000Z`
      })
      .run()
  }

  const seedNote = (clock: VectorClock, body: string): void => {
    fs.writeFileSync(noteFile, `---\ntags: [plans]\n---\n${body}`)
    testDb.db
      .insert(noteMetadata)
      .values({
        id: NOTE,
        path: 'notes/Plans.md',
        title: 'Plans',
        fileType: 'markdown',
        clock,
        createdAt: `${DATE}T08:00:00.000Z`,
        modifiedAt: `${DATE}T08:00:00.000Z`
      })
      .run()
  }

  /** Pull one tombstone through a page, commit it, and land its file ops. */
  const pullDelete = async (
    type: 'journal' | 'note',
    itemId: string,
    payload: Record<string, unknown> = {}
  ): Promise<string> => {
    const page = beginPageApply(asSyncDb(testDb.db))
    const result = new ItemApplier(asSyncDb(testDb.db), vi.fn()).apply(
      {
        itemId,
        type,
        operation: 'delete',
        content: new TextEncoder().encode(JSON.stringify(payload)),
        clock: TOMBSTONE,
        deletedAt: DELETED_S
      },
      page
    )
    page.commit()
    await page.flushFiles()
    return result
  }

  const inbox = () =>
    testDb.db
      .select({ id: inboxItems.id, title: inboxItems.title, content: inboxItems.content })
      .from(inboxItems)
      .all()
  const rowOf = (id: string) =>
    testDb.db
      .select()
      .from(noteMetadata)
      .all()
      .find((r) => r.id === id)

  it('keeps a journal edit still waiting in the body outbox, then deletes the day', async () => {
    seedDay({ a: 4 }, 'Typed offline after the last sync\n')
    new SyncQueueManager(asSyncDb(testDb.db)).enqueueNoteBody(DAY, 'AQID')

    expect(await pullDelete('journal', DAY)).toBe('applied')

    const kept = inbox()
    expect(kept).toEqual([
      {
        id: expect.any(String),
        title: `Journal ${DATE} (kept from deleted day)`,
        content: 'Typed offline after the last sync'
      }
    ])
    expect(syncInboxCreate).toHaveBeenCalledWith(kept[0].id)
    expect(rowOf(DAY)).toBeUndefined()
    expect(fs.existsSync(dayFile)).toBe(false)
  })

  it('keeps a day created offline, whose clock the delete never covered', async () => {
    seedDay({ b: 1 }, 'A day made on the plane\n')

    await pullDelete('journal', DAY)

    expect(inbox().map((item) => item.content)).toEqual(['A day made on the plane'])
    expect(fs.existsSync(dayFile)).toBe(false)
  })

  it('keeps a note body the server stored after the delete, then deletes the note', async () => {
    seedNote({ a: 4 }, 'Pushed on reconnect, before the pull\n')
    recordNoteBodyPush(NOTE, 'confirmed', DELETED_MS + 5_000, asClientDb(testDb.db))

    expect(await pullDelete('note', NOTE)).toBe('applied')

    expect(inbox()).toEqual([
      {
        id: expect.any(String),
        title: 'Plans (kept from deleted note)',
        content: 'Pushed on reconnect, before the pull\n'
      }
    ])
    expect(rowOf(NOTE)).toBeUndefined()
    expect(fs.existsSync(noteFile)).toBe(false)
  })

  it('makes no copy of text the deleting device already had', async () => {
    seedNote({ a: 4 }, 'Synced an hour ago\n')
    recordNoteBodyPush(NOTE, 'confirmed', DELETED_MS - 3_600_000, asClientDb(testDb.db))
    seedDay({ a: 4 }, 'Synced long ago\n')

    await pullDelete('note', NOTE)
    await pullDelete('journal', DAY)

    expect(inbox()).toEqual([])
    expect(syncInboxCreate).not.toHaveBeenCalled()
    expect(fs.existsSync(noteFile)).toBe(false)
    expect(fs.existsSync(dayFile)).toBe(false)
  })

  it('makes one copy when the same delete arrives twice', async () => {
    seedDay({ b: 1 }, 'Only once\n')

    await pullDelete('journal', DAY)
    expect(await pullDelete('journal', DAY)).toBe('skipped')

    expect(inbox().map((item) => item.content)).toEqual(['Only once'])
  })

  /** A Yjs update with one paragraph of `text` from Yjs client `client`. */
  const bodyUpdate = (client: number, text: string): Uint8Array => {
    const doc = new Y.Doc()
    doc.clientID = client
    doc.getText('t').insert(0, text)
    return Y.encodeStateAsUpdate(doc)
  }
  const vectorOf = (update: Uint8Array): string =>
    Buffer.from(Y.encodeStateVectorFromUpdate(update)).toString('base64')

  // #3037: A was offline from 9:00, this device pushed at 9:30, A deleted at
  // 10:00 and pushed at 11:00. `deletedAt` is A's push time, so the push looks
  // old; A's body vector says A never held it.
  it('keeps text pushed long before an offline delete that its body vector does not cover', async () => {
    seedNote({ a: 4 }, 'Pushed at 9:30\n')
    const held = bodyUpdate(1, 'Old')
    const pushedHere = bodyUpdate(2, 'Pushed at 9:30')
    recordNoteBodyPush(NOTE, 'confirmed', DELETED_MS - 5_400_000, asClientDb(testDb.db), [
      held,
      pushedHere
    ])

    expect(
      await pullDelete('note', NOTE, { clock: TOMBSTONE, bodyStateVector: vectorOf(held) })
    ).toBe('applied')

    expect(inbox().map((item) => item.content)).toEqual(['Pushed at 9:30\n'])
    expect(rowOf(NOTE)).toBeUndefined()
  })

  it('makes no copy when the body vector covers every update this device pushed', async () => {
    seedDay({ a: 4 }, 'Seen by the deleter\n')
    const pushedHere = bodyUpdate(2, 'Seen by the deleter')
    recordNoteBodyPush(DAY, 'confirmed', DELETED_MS - 5_400_000, asClientDb(testDb.db), [
      pushedHere
    ])

    await pullDelete('journal', DAY, { clock: TOMBSTONE, bodyStateVector: vectorOf(pushedHere) })

    expect(inbox()).toEqual([])
    expect(fs.existsSync(dayFile)).toBe(false)
  })
})
