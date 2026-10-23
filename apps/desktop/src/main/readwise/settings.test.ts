import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { READWISE_OPTIONS_DEFAULTS } from '@memry/contracts/import-channels'
import { SyncQueueManager } from '@memry/sync-client/queue'
import type { SettingsSyncManager } from '@memry/sync-client/settings-sync'
import { initSettingsSyncManager, resetSettingsSyncManager } from '@memry/sync-client/settings-sync'
import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { getFullPassPending, setFullPassPending } from './sync-state'

let currentDb: DataDb | null = null
vi.mock('../database', () => ({
  getDatabase: () => {
    if (!currentDb) throw new Error('no vault')
    return currentDb
  }
}))

import {
  READWISE_SETTINGS_KEY,
  applyMergedReadwiseSettings,
  followFolderRenameInReadwise,
  readReadwiseOptions,
  writeReadwiseOptions
} from './settings'

beforeAll(async () => {
  await sodium.ready
})

describe('readwise synced settings group', () => {
  let result: TestDatabaseResult
  let db: DataDb
  let manager: SettingsSyncManager

  beforeEach(() => {
    result = createTestDataDb()
    db = asClientDb(result.db)
    currentDb = db
    manager = initSettingsSyncManager({
      db: asSyncDb(result.db),
      queue: new SyncQueueManager(asClientDb(result.db)),
      getDeviceId: () => 'device-A'
    })
  })
  afterEach(() => {
    currentDb = null
    resetSettingsSyncManager()
    result.close()
  })

  it('reads the defaults of D3 when nothing is stored: Readwise folder, subfolders, supplementals off, hourly', () => {
    expect(readReadwiseOptions(db)).toEqual(READWISE_OPTIONS_DEFAULTS)
    expect(READWISE_OPTIONS_DEFAULTS.categories.supplementals).toBe(false)
  })

  it('stores only what the user set and pushes one field clock per leaf', () => {
    writeReadwiseOptions(db, {
      folderLayout: 'flat',
      categories: { supplementals: true }
    })

    expect(JSON.parse(getSetting(db, READWISE_SETTINGS_KEY)!)).toEqual({
      folderLayout: 'flat',
      categories: { supplementals: true }
    })
    expect(Object.keys(manager.getPayload().fieldClocks).sort()).toEqual([
      'readwise.categories.supplementals',
      'readwise.folderLayout'
    ])
    expect(readReadwiseOptions(db)).toMatchObject({
      folderLayout: 'flat',
      rootFolder: 'Readwise',
      categories: { books: true, supplementals: true }
    })
  })

  it('keeps the two Reader switches off until set, each under its own field clock', () => {
    expect(readReadwiseOptions(db)).toMatchObject({ readerDocuments: false, readerFullText: false })

    writeReadwiseOptions(db, { readerDocuments: true, readerFullText: true })

    expect(readReadwiseOptions(db)).toMatchObject({ readerDocuments: true, readerFullText: true })
    expect(Object.keys(manager.getPayload().fieldClocks).sort()).toEqual([
      'readwise.readerDocuments',
      'readwise.readerFullText'
    ])
    // A stored value that is not a boolean reads as the default.
    setSetting(db, READWISE_SETTINGS_KEY, JSON.stringify({ readerDocuments: 'yes' }))
    expect(readReadwiseOptions(db).readerDocuments).toBe(false)
  })

  it('keeps the journal switch off until set, under its own field clock, and never flags a full pass (#3476)', () => {
    expect(readReadwiseOptions(db).journalHighlights).toBe(false)

    writeReadwiseOptions(db, { journalHighlights: true })

    expect(readReadwiseOptions(db).journalHighlights).toBe(true)
    expect(Object.keys(manager.getPayload().fieldClocks)).toEqual(['readwise.journalHighlights'])
    expect(getFullPassPending(db)).toBe(false)
    setSetting(db, READWISE_SETTINGS_KEY, JSON.stringify({ journalHighlights: 'yes' }))
    expect(readReadwiseOptions(db).journalHighlights).toBe(false)
  })

  it('reads a layout or cadence only a newer build knows as the default', () => {
    setSetting(
      db,
      READWISE_SETTINGS_KEY,
      JSON.stringify({ folderLayout: 'by-year', cadence: 'weekly' })
    )
    expect(readReadwiseOptions(db)).toEqual(READWISE_OPTIONS_DEFAULTS)
  })

  it('keeps a field this build does not model when another device merges in', () => {
    writeReadwiseOptions(db, { cadence: 'daily', categories: { books: false } })

    applyMergedReadwiseSettings(db, {
      syncDeviceId: 'device-B',
      categories: { tweets: false }
    })

    expect(JSON.parse(getSetting(db, READWISE_SETTINGS_KEY)!)).toEqual({
      cadence: 'daily',
      syncDeviceId: 'device-B',
      categories: { books: false, tweets: false }
    })
    // A merge is a raw write: it must not echo back into settings sync.
    expect(Object.keys(manager.getPayload().fieldClocks)).not.toContain('readwise.syncDeviceId')
  })

  it('merges the run status leaf by leaf, so one leaf arriving keeps the other', () => {
    setSetting(
      db,
      READWISE_SETTINGS_KEY,
      JSON.stringify({ status: { lastChangeAt: '2026-10-22T08:30:00.000Z', error: null } })
    )

    applyMergedReadwiseSettings(db, { status: { error: 'invalid-token' } })

    expect(JSON.parse(getSetting(db, READWISE_SETTINGS_KEY)!).status).toEqual({
      lastChangeAt: '2026-10-22T08:30:00.000Z',
      error: 'invalid-token'
    })
  })

  it('treats a corrupt or non-object row as empty and writes over it', () => {
    setSetting(db, READWISE_SETTINGS_KEY, '{nope')
    expect(readReadwiseOptions(db)).toEqual(READWISE_OPTIONS_DEFAULTS)
    setSetting(db, READWISE_SETTINGS_KEY, '[1]')
    expect(readReadwiseOptions(db)).toEqual(READWISE_OPTIONS_DEFAULTS)
    setSetting(db, READWISE_SETTINGS_KEY, JSON.stringify({ categories: 'x' }))
    writeReadwiseOptions(db, { categories: { books: false }, cadence: 'manual' })
    expect(JSON.parse(getSetting(db, READWISE_SETTINGS_KEY)!)).toEqual({
      cadence: 'manual',
      categories: { books: false }
    })
  })

  describe('folder rename', () => {
    it('follows a rename of the root folder, including the default one', () => {
      followFolderRenameInReadwise('Readwise', 'Reading')
      expect(readReadwiseOptions(db).rootFolder).toBe('Reading')
      expect(manager.getPayload().settings.readwise?.rootFolder).toBe('Reading')
    })

    it('follows a move of a folder above the root', () => {
      writeReadwiseOptions(db, { rootFolder: 'Inbox/Readwise' })
      followFolderRenameInReadwise('Inbox', 'Archive/Inbox')
      expect(readReadwiseOptions(db).rootFolder).toBe('Archive/Inbox/Readwise')
    })

    it('leaves the setting alone for an unrelated folder or a name prefix', () => {
      writeReadwiseOptions(db, { rootFolder: 'Readwise2' })
      followFolderRenameInReadwise('Readwise', 'Reading')
      followFolderRenameInReadwise('Work', 'Job')
      expect(readReadwiseOptions(db).rootFolder).toBe('Readwise2')
    })

    it('does nothing without an open vault', () => {
      currentDb = null
      expect(() => followFolderRenameInReadwise('Readwise', 'Reading')).not.toThrow()
    })
  })

  describe('full-pass flag (D7)', () => {
    it('is set when a category goes from off to on, by the user or a merged device', () => {
      writeReadwiseOptions(db, { categories: { supplementals: true } })
      expect(getFullPassPending(db)).toBe(true)

      setFullPassPending(db, false)
      applyMergedReadwiseSettings(db, { categories: { tweets: false } })
      expect(getFullPassPending(db)).toBe(false)
      applyMergedReadwiseSettings(db, { categories: { tweets: true } })
      expect(getFullPassPending(db)).toBe(true)
    })

    it('is set when saved Reader documents go from off to on, never for the text switch', () => {
      writeReadwiseOptions(db, { readerFullText: true })
      expect(getFullPassPending(db)).toBe(false)
      writeReadwiseOptions(db, { readerDocuments: true })
      expect(getFullPassPending(db)).toBe(true)
      setFullPassPending(db, false)
      writeReadwiseOptions(db, { readerDocuments: false })
      applyMergedReadwiseSettings(db, { readerDocuments: true })
      expect(getFullPassPending(db)).toBe(true)
    })

    it('stays clear when nothing was switched on', () => {
      writeReadwiseOptions(db, { categories: { books: false } })
      writeReadwiseOptions(db, { categories: { articles: true }, rootFolder: 'Reading' })
      expect(getFullPassPending(db)).toBe(false)
    })
  })
})
