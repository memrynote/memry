/**
 * Journal writes under a locked folder (#2606). The journal writer goes
 * through the note content store, not `atomicWrite`, so it runs the lock
 * check itself before it renames over or unlinks the day's file.
 *
 * @module vault/journal-vault-locks.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

const state = vi.hoisted(() => ({
  data: null as unknown,
  index: null as unknown,
  vaultPath: ''
}))

vi.mock('../database', () => ({
  getDatabase: () => state.data,
  getIndexDatabase: () => state.index,
  isDatabaseInitialized: () => state.data !== null,
  isIndexDatabaseInitialized: () => state.index !== null
}))
vi.mock('./index', () => ({
  getStatus: () => ({ path: state.vaultPath, isOpen: true }),
  getConfig: () => ({
    journalFolder: 'Life/Daily',
    defaultNoteFolder: 'notes',
    attachmentsFolder: 'attachments',
    excludePatterns: []
  })
}))

import { deleteJournalEntryFile, getJournalPath, writeJournalEntryWithContent } from './journal'
import { installVaultLockFileGuard } from '../vault-locks/files'
import { invalidateVaultLocks } from '../vault-locks/registry'
import { writeLockRow } from '../vault-locks/store'
import { setVaultFileWriteGuard } from './file-ops'

const DATE = '2026-03-04'
const EMPTY_DATE = '2026-03-05'
const ORIGINAL = '---\nid: j_locked\ndate: 2026-03-04\n---\nLocked day\n'

describe('journal writes under a locked folder are refused (#2606)', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let file: string

  beforeEach(() => {
    state.vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-locks-'))
    data = createTestDataDb()
    index = createTestIndexDb()
    state.data = data.db
    state.index = index.db
    file = getJournalPath(DATE)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, ORIGINAL)
    installVaultLockFileGuard()
    writeLockRow(asClientDb(data.db), 'folder', 'Life', true)
    invalidateVaultLocks()
  })

  afterEach(() => {
    setVaultFileWriteGuard(null)
    invalidateVaultLocks()
    data.close()
    index.close()
    state.data = null
    state.index = null
    fs.rmSync(state.vaultPath, { recursive: true, force: true })
  })

  it('a write to an existing day is refused and the file keeps its bytes', async () => {
    await expect(writeJournalEntryWithContent(DATE, 'Overwritten')).rejects.toThrow(
      VAULT_LOCKED_NOTE_MESSAGE
    )

    expect(fs.readFileSync(file, 'utf8')).toBe(ORIGINAL)
  })

  it('creating a day under the locked folder is refused and writes no file', async () => {
    await expect(writeJournalEntryWithContent(EMPTY_DATE, 'New day')).rejects.toThrow(
      VAULT_LOCKED_NOTE_MESSAGE
    )

    expect(fs.existsSync(getJournalPath(EMPTY_DATE))).toBe(false)
  })

  it('a delete is refused and the file stays', async () => {
    await expect(deleteJournalEntryFile(DATE)).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)

    expect(fs.readFileSync(file, 'utf8')).toBe(ORIGINAL)
  })

  it('after unlocking, the write and the delete go through', async () => {
    writeLockRow(asClientDb(data.db), 'folder', 'Life', false)
    invalidateVaultLocks()

    await writeJournalEntryWithContent(DATE, 'Edited after unlock')
    expect(fs.readFileSync(file, 'utf8')).toContain('Edited after unlock')

    await expect(deleteJournalEntryFile(DATE)).resolves.toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })
})
