import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

// #2284: a synced journal's row and file, and the properties.md rewrite of a
// remote property-definition delete, commit, roll back and replay with the page.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-page-apply-'))
const vaultPath = path.join(root, 'vault')
const userDataDir = path.join(root, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const { syncNoteToCacheMock, currentDb } = vi.hoisted(() => ({
  syncNoteToCacheMock: vi.fn(),
  currentDb: { value: null as unknown }
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => userDataDir) } }))
vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})
vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('../../database/client', () => ({
  getIndexDatabase: vi.fn(() => ({ index: true })),
  isIndexDatabaseInitialized: vi.fn(() => false),
  getRawIndexDatabase: vi.fn(() => null)
}))
vi.mock('../../database', () => ({
  getDatabase: () => currentDb.value,
  getIndexDatabase: () => currentDb.value
}))
vi.mock('../../vault/init', () => ({
  getMemryDir: (vault: string) => path.join(vault, '.memry')
}))
vi.mock('../../vault/index', () => ({
  getStatus: () => ({ path: vaultPath, isOpen: true }),
  getConfig: () => ({ journalFolder: 'journal', defaultNoteFolder: 'notes' })
}))
vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: (...args: unknown[]) => syncNoteToCacheMock(...args),
  deleteNoteFromCache: vi.fn()
}))
vi.mock('../crdt-provider', () => ({
  getCrdtProvider: () => ({ purge: vi.fn(() => Promise.resolve()) })
}))
vi.mock('../../projections', () => ({ flushProjectionEvents: vi.fn() }))

import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { beginPageApply, replayBulkApplyJournal, _resetBulkApplyForTests } from '../bulk-apply'
import { PropertyDefinitionsService } from '../../vault/property-definitions'
import { journalHandler } from './journal-handler'
import { propertyDefinitionHandler } from './property-definition-handler'

const DATE = '2026-09-24'
const ITEM_ID = 'journal-2026-09-24'
const journalFile = path.join(vaultPath, 'journal', `${DATE}.md`)

describe('journal handler inside a page transaction (#2284)', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    _resetBulkApplyForTests()
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.rmSync(path.join(userDataDir, 'sync-bulk-apply-journal.json'), { force: true })
    syncNoteToCacheMock.mockReset()
    testDb = createTestDataDb()
  })

  afterEach(() => {
    _resetBulkApplyForTests()
    testDb.close()
  })

  const rowOf = () =>
    testDb.db.select().from(noteMetadata).where(eq(noteMetadata.id, ITEM_ID)).get()

  const applyInPage = () => {
    const page = beginPageApply(asSyncDb(testDb.db))
    const result = journalHandler.applyUpsert(
      { db: page.db, emit: vi.fn() },
      ITEM_ID,
      { date: DATE, content: 'Remote body', tags: ['sync'] },
      { 'device-b': 1 }
    )
    return { page, result }
  }

  it('commits the row with the page and writes the file on flush', async () => {
    const { page, result } = applyInPage()

    expect(result).toBe('applied')
    expect(syncNoteToCacheMock).toHaveBeenCalledTimes(1)
    page.commit()

    expect(rowOf()).toMatchObject({ id: ITEM_ID, journalDate: DATE, clock: { 'device-b': 1 } })
    expect(fs.existsSync(journalFile)).toBe(false)

    await page.flushFiles()

    expect(fs.readFileSync(journalFile, 'utf-8')).toContain('Remote body')
  })

  it('rolls the row back with the page', () => {
    const { page } = applyInPage()
    page.rollback()

    expect(rowOf()).toBeUndefined()
    expect(fs.existsSync(journalFile)).toBe(false)
  })

  it('replays the file write after a crash between commit and flush', () => {
    const { page } = applyInPage()
    page.commit()
    _resetBulkApplyForTests()

    replayBulkApplyJournal()

    expect(rowOf()).toMatchObject({ id: ITEM_ID })
    expect(fs.readFileSync(journalFile, 'utf-8')).toContain('Remote body')
  })

  it('updates an existing entry in place, keeping its createdAt', async () => {
    const first = applyInPage()
    first.page.commit()
    await first.page.flushFiles()
    const createdAt = rowOf()?.createdAt

    const page = beginPageApply(asSyncDb(testDb.db))
    const result = journalHandler.applyUpsert(
      { db: page.db, emit: vi.fn() },
      ITEM_ID,
      { date: DATE, content: 'Edited on B', tags: ['sync'] },
      { 'device-b': 2 }
    )
    page.commit()
    await page.flushFiles()

    expect(result).toBe('applied')
    expect(rowOf()).toMatchObject({ clock: { 'device-b': 2 }, createdAt })
    expect(fs.readFileSync(journalFile, 'utf-8')).toContain('Edited on B')
  })
})

describe('property definition delete inside a page transaction (#2284)', () => {
  let testDb: TestDatabaseResult
  const propertiesFile = path.join(vaultPath, '.memry', 'properties.md')

  beforeEach(() => {
    _resetBulkApplyForTests()
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.rmSync(path.join(userDataDir, 'sync-bulk-apply-journal.json'), { force: true })
    fs.mkdirSync(path.dirname(propertiesFile), { recursive: true })
    fs.writeFileSync(
      propertiesFile,
      '---\nproperties:\n  Stage:\n    type: select\n    options: []\n  Area:\n    type: text\n    options: []\n---\n'
    )
    testDb = createTestDataDb()
    currentDb.value = testDb.db
    testDb.db
      .insert(propertyDefinitions)
      .values({ name: 'Stage', type: 'select', clock: { 'device-a': 1 }, createdAt: '2026-01-01' })
      .run()
    PropertyDefinitionsService.init(vaultPath)
  })

  afterEach(() => {
    PropertyDefinitionsService.destroy()
    _resetBulkApplyForTests()
    testDb.close()
  })

  it('journals the properties.md rewrite so a crash cannot bring the definition back', async () => {
    await PropertyDefinitionsService.get().reload()
    const page = beginPageApply(asSyncDb(testDb.db))

    const result = propertyDefinitionHandler.applyDelete({ db: page.db, emit: vi.fn() }, 'Stage', {
      'device-b': 5
    })
    page.commit()
    expect(result).toBe('applied')
    expect(fs.readFileSync(propertiesFile, 'utf-8')).toContain('Stage')

    _resetBulkApplyForTests()
    replayBulkApplyJournal()

    const healed = fs.readFileSync(propertiesFile, 'utf-8')
    expect(healed).not.toContain('Stage')
    expect(healed).toContain('Area')
  })
})
