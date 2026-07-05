import { describe, expect, it } from 'vitest'

import { NOTES, NOTE_METADATA } from './notes'

describe('notes seed data', () => {
  it('includes a consumer-facing Istanbul note that showcases note features', () => {
    const istanbul = NOTES.find((note) => note.relativePath === 'travel/Istanbul.md')

    expect(istanbul).toBeDefined()
    // User keys only — no Memry keys in seed frontmatter
    expect(istanbul?.frontmatter.id).toBeUndefined()
    expect(istanbul?.frontmatter.title).toBeUndefined()
    expect(istanbul?.frontmatter.created).toBeUndefined()
    expect(istanbul?.frontmatter.modified).toBeUndefined()
    expect(istanbul?.frontmatter.tags).toEqual(['travel', 'istanbul', 'planning'])
    expect(istanbul?.frontmatter.location).toBe('Istanbul, Turkey')
    expect(istanbul?.frontmatter.status).toBe('planning')

    // Identity + dates live in NOTE_METADATA (note_metadata seeding) and file mtime
    const metadata = NOTE_METADATA.find((meta) => meta.path === 'travel/Istanbul.md')
    expect(metadata?.title).toBe('Istanbul')
    expect(metadata?.id).toBeTruthy()
    expect(istanbul?.modified).toBe(metadata?.modifiedAt)

    const body = istanbul?.body ?? ''

    expect(body).toContain('![Bosphorus ferry at sunset]')
    expect(body).toContain('## Plan')
    expect(body).toContain('> [!info]')
    expect(body).toContain('| Day | Area | Anchor |')
    expect(body).toContain('- [ ]')
    expect(body).toContain('[[Packing List]]')
    expect(body).toContain('[[Food Diary]]')
    expect(body).toContain('https://sehirhatlari.istanbul')
    expect(body).toContain('#travel #istanbul #planning')

    for (const technicalTerm of [
      'CRDT',
      'IPC',
      'PR',
      'memrynote',
      'Drizzle',
      'seed data',
      'renderer',
      'database'
    ]) {
      expect(body).not.toContain(technicalTerm)
    }
  })
})
