import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folderExistsExactCase, inferMovedJournalFolder } from './journal-folder-follow'

describe('inferMovedJournalFolder', () => {
  it('finds the folder an entry moved to with the path below it unchanged', () => {
    expect(
      inferMovedJournalFolder('Daily Notes', 'Daily Notes/2026-10-01.md', 'Diary/2026-10-01.md')
    ).toBe('Diary')
    expect(
      inferMovedJournalFolder(
        'Daily Notes',
        'Daily Notes/2025/January/2025-01-14.md',
        'Archive/Daily Notes/2025/January/2025-01-14.md'
      )
    ).toBe('Archive/Daily Notes')
  })

  it('ignores a move that changes the path below the journal folder', () => {
    expect(
      inferMovedJournalFolder('journal', 'journal/2026-10-01.md', 'notes/renamed.md')
    ).toBeNull()
    expect(inferMovedJournalFolder('journal', 'journal/2026-10-01.md', '2026-10-01.md')).toBeNull()
    expect(
      inferMovedJournalFolder('journal', 'other/2026-10-01.md', 'Diary/2026-10-01.md')
    ).toBeNull()
  })
})

describe('folderExistsExactCase', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-journal-follow-'))
    fs.mkdirSync(path.join(vault, 'Notes', 'Daily'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true })
  })

  it('matches only the exact spelling, even on a case-insensitive file system', () => {
    expect(folderExistsExactCase(vault, 'Notes/Daily')).toBe(true)
    expect(folderExistsExactCase(vault, 'notes/daily')).toBe(false)
    expect(folderExistsExactCase(vault, 'Notes/Missing')).toBe(false)
  })
})
