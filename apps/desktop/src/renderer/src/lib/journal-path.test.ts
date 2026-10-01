import { describe, expect, it } from 'vitest'
import { containsJournalFolder, journalDateForPath } from './journal-path'

const flat = { journalFolder: 'Daily Notes', journalDateFormat: 'YYYY-MM-DD' }
const nested = { journalFolder: '/Daily Notes/', journalDateFormat: 'YYYY/MMMM/YYYY-MM-DD' }

describe('journalDateForPath', () => {
  it('reads the date of a path inside the journal folder, as main does', () => {
    expect(journalDateForPath('Daily Notes/2026-10-01.md', flat)).toBe('2026-10-01')
    expect(journalDateForPath('Daily Notes/2026/October/2026-10-01.md', nested)).toBe('2026-10-01')
  })

  it('is null for anything main would list as a note', () => {
    expect(journalDateForPath('Daily Notes/ideas.md', flat)).toBeNull()
    expect(journalDateForPath('Work/2026-10-01.md', flat)).toBeNull()
    expect(journalDateForPath('Daily Notes/2026-10-01.pdf', flat)).toBeNull()
    expect(journalDateForPath('Daily Notes/2026-10-01.md', nested)).toBeNull()
    expect(journalDateForPath('2026-10-01.md', { ...flat, journalFolder: '' })).toBeNull()
  })
})

describe('containsJournalFolder', () => {
  it('is true for the journal folder and the folders above it', () => {
    expect(containsJournalFolder('Life/Daily', 'Life/Daily')).toBe(true)
    expect(containsJournalFolder('Life', '/Life/Daily/')).toBe(true)
    expect(containsJournalFolder('Life/Daily/2026', 'Life/Daily')).toBe(false)
    expect(containsJournalFolder('Lif', 'Life/Daily')).toBe(false)
    expect(containsJournalFolder('Life', '')).toBe(false)
  })
})
