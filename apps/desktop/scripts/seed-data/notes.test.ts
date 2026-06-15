import { describe, expect, it } from 'vitest'

import { NOTES } from './notes'

describe('notes seed data', () => {
  it('includes a consumer-facing Istanbul note that showcases note features', () => {
    const istanbul = NOTES.find((note) => note.frontmatter.title === 'Istanbul')

    expect(istanbul).toBeDefined()
    expect(istanbul?.relativePath).toBe('travel/Istanbul.md')
    expect(istanbul?.frontmatter.tags).toEqual(['travel', 'istanbul', 'planning'])
    expect(istanbul?.frontmatter.location).toBe('Istanbul, Turkey')
    expect(istanbul?.frontmatter.status).toBe('planning')

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
