import { describe, expect, it } from 'vitest'

import { listHelpPages, readHelp, searchHelp } from '../help-docs'

function topSections(query: string): string[] {
  return searchHelp(query, 3).map((hit) => `${hit.page}#${hit.section ?? ''}`)
}

describe('bundled user guide', () => {
  it.each([
    [
      'how do I show a note on the calendar',
      'user-guide/faq#How do I show a note on the calendar?'
    ],
    [
      'note date property calendar',
      'user-guide/notes/properties-tags#Showing Dates on the Calendar'
    ],
    ['search text inside pdf', 'user-guide/search#Text in PDFs and images'],
    ['keep pdf and photo in vault', 'user-guide/faq#Can I keep PDFs and photos in my vault?']
  ])('finds the guide section that answers "%s"', (query, expected) => {
    expect(topSections(query)).toContain(expected)
  })

  it('leaves out the CLI and agent API reference pages', () => {
    const pages = listHelpPages()
    expect(pages).toContain('user-guide/search')
    expect(pages).toContain('user-guide/faq')
    for (const page of [
      'user-guide/cli',
      'user-guide/cli-reference',
      'user-guide/ai/agent-api-reference',
      'user-guide/ai/agent-mcp',
      'user-guide/ai/agent-backends'
    ]) {
      expect(pages).not.toContain(page)
    }
  })

  it('reads a section with its subsections, or the whole page, without screenshot placeholders', () => {
    const bookmarking = readHelp('user-guide/notes/bookmarks-reminders', 'Bookmarking')
    expect(bookmarking?.text).toContain('### On iPhone')
    expect(bookmarking?.text).not.toContain('## Reminders')
    const section = readHelp('user-guide/search', 'Text in PDFs and images')
    expect(section?.text).toContain('PDFs and images')
    const page = readHelp('user-guide/search')
    expect(page?.text).toContain('## Text in PDFs and images')
    expect(page?.text).not.toContain('<!--')
    expect(readHelp('user-guide/nope')).toBeNull()
  })

  it('answers that PDF annotation is not supported', () => {
    const [hit] = searchHelp('annotate highlight pdf', 1)
    expect(hit.page).toBe('user-guide/faq')
  })
})
