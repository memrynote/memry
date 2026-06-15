import { describe, it, expect, afterEach } from 'vitest'
import { isJournalEntry, extractDateFromPath, generateJournalPath } from './journal-queries'
import { setJournalConfig } from '@main/vault/journal-config'

// These exercise the config-aware journal detection used by the indexer/watcher.
// The journal-config holder is kept fresh by the vault's getConfig(); here we set
// it directly to simulate different vault configurations.

afterEach(() => {
  setJournalConfig({ journalFolder: 'journal', journalDateFormat: 'YYYY-MM-DD' })
})

describe('journal detection (config-aware)', () => {
  it('detects a daily note in the configured folder with the default format', () => {
    setJournalConfig({ journalFolder: 'Daily', journalDateFormat: 'YYYY-MM-DD' })

    expect(isJournalEntry('Daily/2026-06-15.md')).toBe(true)
    expect(extractDateFromPath('Daily/2026-06-15.md')).toBe('2026-06-15')
    expect(generateJournalPath('2026-06-15')).toBe('Daily/2026-06-15.md')
  })

  it('treats non-date and wrong-folder files as regular notes', () => {
    setJournalConfig({ journalFolder: 'Daily', journalDateFormat: 'YYYY-MM-DD' })

    expect(isJournalEntry('Daily/ideas.md')).toBe(false) // not a date filename
    expect(isJournalEntry('Projects/2026-06-15.md')).toBe(false) // wrong folder
    expect(isJournalEntry('Welcome.md')).toBe(false) // root note
    expect(isJournalEntry('Daily/sub/2026-06-15.md')).toBe(false) // not a direct child
    expect(extractDateFromPath('Daily/ideas.md')).toBeNull()
  })

  it('respects a custom date format for detection and naming', () => {
    setJournalConfig({ journalFolder: 'Daily', journalDateFormat: 'DD-MM-YYYY' })

    expect(isJournalEntry('Daily/15-06-2026.md')).toBe(true)
    expect(extractDateFromPath('Daily/15-06-2026.md')).toBe('2026-06-15')
    expect(generateJournalPath('2026-06-15')).toBe('Daily/15-06-2026.md')
    // A file in the default ISO shape no longer matches the custom format
    expect(isJournalEntry('Daily/2026-06-15.md')).toBe(false)
  })

  it('disables journal detection when the journal folder is empty', () => {
    setJournalConfig({ journalFolder: '', journalDateFormat: 'YYYY-MM-DD' })

    expect(isJournalEntry('2026-06-15.md')).toBe(false)
    expect(isJournalEntry('journal/2026-06-15.md')).toBe(false)
  })

  it('uses the default journal folder + format out of the box', () => {
    expect(isJournalEntry('journal/2026-06-15.md')).toBe(true)
    expect(extractDateFromPath('journal/2026-06-15.md')).toBe('2026-06-15')
    expect(generateJournalPath('2026-06-15')).toBe('journal/2026-06-15.md')
  })
})
