import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'
import { getNoteMetadataById, getNoteMetadataByPath, upsertNoteMetadata } from '@memry/storage-data'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getNotePosition, setNotePosition } from '@main/database/queries/note-positions'

const mocks = vi.hoisted(() => ({ getDatabase: vi.fn() }))
vi.mock('../database', () => ({ getDatabase: mocks.getDatabase }))

import {
  isCompleteJournalFormat,
  planJournalRenames,
  renameJournalsForFormatChange
} from './journal-format-migration'
import { installVaultLockSource, invalidateVaultLocks } from '../vault-locks/registry'
import { writeLockRow } from '../vault-locks/store'

const DAILY = 'YYYY-MM-DD'
const WEEKDAY = 'YYYY-MM-DD dddd'

describe('isCompleteJournalFormat', () => {
  it('accepts formats that carry year, month and day', () => {
    for (const format of ['', DAILY, WEEKDAY, 'DD.MM.YY', 'dddd, D-M-YYYY']) {
      expect(isCompleteJournalFormat(format)).toBe(true)
    }
  })

  it('rejects formats missing a date field', () => {
    for (const format of ['YYYY-MM', 'MM-DD', 'YYYY dddd', 'notes']) {
      expect(isCompleteJournalFormat(format)).toBe(false)
    }
  })
})

describe('planJournalRenames', () => {
  it('renames every journal file to the new format and leaves other files alone', () => {
    const plan = planJournalRenames(
      ['2026-09-25.md', '2026-09-26.md', 'ideas.md', '2026-09-27.txt'],
      DAILY,
      WEEKDAY
    )
    expect(plan.renames).toEqual([
      { from: '2026-09-25.md', to: '2026-09-25 Friday.md', date: '2026-09-25' },
      { from: '2026-09-26.md', to: '2026-09-26 Saturday.md', date: '2026-09-26' }
    ])
    expect(plan.skipped).toEqual([])
  })

  it('never targets a name that already exists', () => {
    const plan = planJournalRenames(['2026-09-26.md', '2026-09-26 Saturday.md'], DAILY, WEEKDAY)
    expect(plan.renames).toEqual([])
    expect(plan.skipped).toEqual([{ file: '2026-09-26.md', reason: 'target-exists' }])
  })

  it('treats names that differ only in case as the same file', () => {
    const plan = planJournalRenames(['2026-09-26.md', '2026-09-26 saturday.md'], DAILY, WEEKDAY)
    expect(plan.renames).toEqual([])
    expect(plan.skipped).toEqual([{ file: '2026-09-26.md', reason: 'target-exists' }])
  })

  it('lets only one of two files for the same date claim the new name', () => {
    const plan = planJournalRenames(['26-6-5.md', '26-06-05.md'], 'YY-M-D', DAILY)
    expect(plan.renames).toEqual([{ from: '26-06-05.md', to: '2026-06-05.md', date: '2026-06-05' }])
    expect(plan.skipped).toEqual([{ file: '26-6-5.md', reason: 'target-exists' }])
  })

  it('skips a swap rather than overwrite either side', () => {
    // 05-06 is 5 June under DD-MM and 6 May's new name under MM-DD, and vice versa.
    const plan = planJournalRenames(['05-06-2026.md', '06-05-2026.md'], 'DD-MM-YYYY', 'MM-DD-YYYY')
    expect(plan.renames).toEqual([])
    expect(plan.skipped).toHaveLength(2)
  })
})

describe('renameJournalsForFormatChange', () => {
  let vaultPath: string
  let testDb: TestDatabaseResult

  const journalFile = (name: string): string => path.join(vaultPath, 'journal', name)

  function seedJournal(name: string, id: string, date: string): void {
    fs.writeFileSync(journalFile(name), `entry for ${date}\n`)
    upsertNoteMetadata(asClientDb(testDb.db), {
      id,
      path: `journal/${name}`,
      title: name.slice(0, -3),
      journalDate: date,
      createdAt: '2026-09-01T00:00:00.000Z',
      modifiedAt: '2026-09-01T00:00:00.000Z'
    })
  }

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-journal-format-'))
    fs.mkdirSync(path.join(vaultPath, 'journal'))
    testDb = createTestDataDb()
    mocks.getDatabase.mockReturnValue(asClientDb(testDb.db))
  })

  afterEach(() => {
    testDb.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('moves the file and its canonical row, keeping id and journal date', async () => {
    seedJournal('2026-09-25.md', 'j2026-09-25', '2026-09-25')
    setNotePosition(asClientDb(testDb.db), 'journal/2026-09-25.md', 'journal', 3)

    const result = await renameJournalsForFormatChange(vaultPath, 'journal', DAILY, WEEKDAY)

    expect(result).toEqual({ renamed: 1, skipped: 0, failed: 0 })
    expect(fs.existsSync(journalFile('2026-09-25.md'))).toBe(false)
    expect(fs.readFileSync(journalFile('2026-09-25 Friday.md'), 'utf-8')).toBe(
      'entry for 2026-09-25\n'
    )
    const row = getNoteMetadataById(asClientDb(testDb.db), 'j2026-09-25')
    expect(row?.path).toBe('journal/2026-09-25 Friday.md')
    expect(row?.journalDate).toBe('2026-09-25')
    expect(getNotePosition(asClientDb(testDb.db), 'journal/2026-09-25 Friday.md')?.position).toBe(3)
  })

  it('leaves both files untouched when the new name is taken', async () => {
    seedJournal('2026-09-26.md', 'j2026-09-26', '2026-09-26')
    fs.writeFileSync(journalFile('2026-09-26 Saturday.md'), 'obsidian note\n')

    const result = await renameJournalsForFormatChange(vaultPath, 'journal', DAILY, WEEKDAY)

    expect(result).toEqual({ renamed: 0, skipped: 1, failed: 0 })
    expect(fs.readFileSync(journalFile('2026-09-26.md'), 'utf-8')).toBe('entry for 2026-09-26\n')
    expect(fs.readFileSync(journalFile('2026-09-26 Saturday.md'), 'utf-8')).toBe('obsidian note\n')
    expect(getNoteMetadataById(asClientDb(testDb.db), 'j2026-09-26')?.path).toBe(
      'journal/2026-09-26.md'
    )
  })

  it('skips a file whose new name is still held by a canonical row', async () => {
    seedJournal('2026-09-26.md', 'j2026-09-26', '2026-09-26')
    upsertNoteMetadata(asClientDb(testDb.db), {
      id: 'stale',
      path: 'journal/2026-09-26 Saturday.md',
      title: 'stale',
      createdAt: '2026-09-01T00:00:00.000Z',
      modifiedAt: '2026-09-01T00:00:00.000Z'
    })

    const result = await renameJournalsForFormatChange(vaultPath, 'journal', DAILY, WEEKDAY)

    expect(result).toEqual({ renamed: 0, skipped: 1, failed: 0 })
    expect(fs.existsSync(journalFile('2026-09-26.md'))).toBe(true)
  })

  it('renames nothing for a format that cannot name every date', async () => {
    seedJournal('2026-09-25.md', 'j2026-09-25', '2026-09-25')

    const result = await renameJournalsForFormatChange(vaultPath, 'journal', DAILY, 'YYYY-MM')

    expect(result).toEqual({ renamed: 0, skipped: 0, failed: 0 })
    expect(fs.existsSync(journalFile('2026-09-25.md'))).toBe(true)
  })

  it('renames a file the index has never seen', async () => {
    fs.writeFileSync(journalFile('2026-09-27.md'), 'external\n')

    const result = await renameJournalsForFormatChange(vaultPath, 'journal/', DAILY, WEEKDAY)

    expect(result.renamed).toBe(1)
    expect(fs.existsSync(journalFile('2026-09-27 Sunday.md'))).toBe(true)
  })

  it('moves flat entries into year/month folders and back, pruning emptied folders', async () => {
    seedJournal('2025-01-14.md', 'j2025-01-14', '2025-01-14')
    fs.writeFileSync(journalFile('ideas.md'), 'not a journal\n')
    const nested = 'YYYY/MMMM/YYYY-MM-DD'

    const toNested = await renameJournalsForFormatChange(vaultPath, 'journal', DAILY, nested)

    expect(toNested).toEqual({ renamed: 1, skipped: 0, failed: 0 })
    expect(fs.existsSync(journalFile('2025/January/2025-01-14.md'))).toBe(true)
    expect(fs.existsSync(journalFile('ideas.md'))).toBe(true)
    expect(getNoteMetadataById(asClientDb(testDb.db), 'j2025-01-14')?.path).toBe(
      'journal/2025/January/2025-01-14.md'
    )

    fs.writeFileSync(journalFile('2025/notes.md'), 'kept\n')
    const toFlat = await renameJournalsForFormatChange(vaultPath, 'journal', nested, DAILY)

    expect(toFlat).toEqual({ renamed: 1, skipped: 0, failed: 0 })
    expect(fs.existsSync(journalFile('2025-01-14.md'))).toBe(true)
    // `January` was emptied and removed; `2025` still holds a file and stays.
    expect(fs.existsSync(journalFile('2025/January'))).toBe(false)
    expect(fs.existsSync(journalFile('2025/notes.md'))).toBe(true)
    expect(fs.existsSync(path.join(vaultPath, 'journal'))).toBe(true)
  })

  it('is a no-op when the journal folder does not exist', async () => {
    const result = await renameJournalsForFormatChange(vaultPath, 'daily', DAILY, WEEKDAY)
    expect(result).toEqual({ renamed: 0, skipped: 0, failed: 0 })
  })
})

describe('renameJournalsForFormatChange under a read-only lock (#2606)', () => {
  let vaultPath: string
  let testDb: TestDatabaseResult

  const journalFile = (name: string): string => path.join(vaultPath, 'journal', name)

  function seedJournal(name: string, id: string, date: string): void {
    fs.writeFileSync(journalFile(name), `entry for ${date}\n`)
    upsertNoteMetadata(asClientDb(testDb.db), {
      id,
      path: `journal/${name}`,
      title: name.slice(0, -3),
      journalDate: date,
      createdAt: '2026-09-01T00:00:00.000Z',
      modifiedAt: '2026-09-01T00:00:00.000Z'
    })
  }

  function lock(kind: 'note' | 'folder', target: string, locked: boolean): void {
    writeLockRow(asClientDb(testDb.db), kind, target, locked)
    invalidateVaultLocks()
  }

  function journalFiles(): string[] {
    return fs.readdirSync(path.join(vaultPath, 'journal'), { recursive: true }).map(String).sort()
  }

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-journal-format-locks-'))
    fs.mkdirSync(path.join(vaultPath, 'journal'))
    testDb = createTestDataDb()
    const db = asClientDb(testDb.db)
    mocks.getDatabase.mockReturnValue(db)
    installVaultLockSource({
      dataDb: () => db,
      notePathOf: (noteId) => getNoteMetadataById(db, noteId)?.path ?? null,
      noteIdAtPath: (relativePath) => getNoteMetadataByPath(db, relativePath)?.id ?? null
    })
    seedJournal('2026-09-25.md', 'j2026-09-25', '2026-09-25')
    seedJournal('2026-09-26.md', 'j2026-09-26', '2026-09-26')
  })

  afterEach(() => {
    installVaultLockSource({ dataDb: () => null, notePathOf: () => null, noteIdAtPath: () => null })
    testDb.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('refuses before renaming anything when one entry is a locked note', async () => {
    lock('note', 'j2026-09-26', true)

    await expect(
      renameJournalsForFormatChange(vaultPath, 'journal', DAILY, WEEKDAY)
    ).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)

    expect(journalFiles()).toEqual(['2026-09-25.md', '2026-09-26.md'])
    expect(getNoteMetadataById(asClientDb(testDb.db), 'j2026-09-25')?.path).toBe(
      'journal/2026-09-25.md'
    )
  })

  it('refuses when a locked folder covers the journal folder', async () => {
    lock('folder', 'journal', true)

    await expect(
      renameJournalsForFormatChange(vaultPath, 'journal', DAILY, WEEKDAY)
    ).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)

    expect(journalFiles()).toEqual(['2026-09-25.md', '2026-09-26.md'])
  })

  it('refuses when a rename would move an entry into a locked folder', async () => {
    lock('folder', 'journal/2026', true)

    await expect(
      renameJournalsForFormatChange(vaultPath, 'journal', DAILY, 'YYYY/MMMM/YYYY-MM-DD')
    ).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)

    expect(journalFiles()).toEqual(['2026-09-25.md', '2026-09-26.md'])
  })

  it('renames as before once the lock is off', async () => {
    lock('folder', 'journal', true)
    lock('folder', 'journal', false)

    const result = await renameJournalsForFormatChange(vaultPath, 'journal', DAILY, WEEKDAY)

    expect(result).toEqual({ renamed: 2, skipped: 0, failed: 0 })
    expect(journalFiles()).toEqual(['2026-09-25 Friday.md', '2026-09-26 Saturday.md'])
  })
})
