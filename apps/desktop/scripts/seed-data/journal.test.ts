import { describe, expect, it } from 'vitest'

import { seedDateOnly } from './date'
import { JOURNAL_METADATA, JOURNAL_NOTES } from './journal'

describe('journal seed data', () => {
  it('has a generic journal entry for the day the seed command runs', () => {
    const today = seedDateOnly(0)
    const todayEntries = JOURNAL_NOTES.filter((note) => note.frontmatter.date === today)

    expect(todayEntries).toHaveLength(1)

    const [entry] = todayEntries
    expect(entry.relativePath).toBe(`journal/${today}.md`)
    // User keys only — no Memry keys; title comes from the filename via metadata
    expect(entry.frontmatter.id).toBeUndefined()
    expect(entry.frontmatter.title).toBeUndefined()
    expect(entry.frontmatter.mood).toBe(4)
    expect(entry.frontmatter.tags).toEqual(['daily', 'reflection'])
    expect(entry.modified).toBeDefined()

    const metadata = JOURNAL_METADATA.find((meta) => meta.journalDate === today)
    expect(metadata?.title).toBe(today)
    expect(metadata?.path).toBe(`journal/${today}.md`)
    expect(entry.body).toContain('A quiet day')
    expect(entry.body).toContain('## Schedule')
    expect(entry.body).toContain('## Tasks')
    expect(entry.body).toContain('- [ ]')
    expect(entry.body).toContain('[[Lisbon Notes]]')
    expect(entry.body).toContain('[[Food Diary]]')

    for (const technicalTerm of [
      'CRDT',
      'IPC',
      'PR',
      'memrynote',
      'Drizzle',
      'field_clocks',
      'sync edge case',
      'Inbox redesign'
    ]) {
      expect(entry.body).not.toContain(technicalTerm)
    }
  })
})
