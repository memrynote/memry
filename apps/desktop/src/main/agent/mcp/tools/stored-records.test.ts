import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getNoteById: vi.fn(),
  readJournalEntry: vi.fn(),
  readJournalFile: vi.fn()
}))

vi.mock('../../../database/queries/notes', () => ({
  getNoteCacheById: () => ({ fileType: 'markdown' })
}))
vi.mock('../../../database/queries/projects', () => ({ getStatusById: vi.fn() }))
vi.mock('../../../vault/notes', () => ({ getNoteById: mocks.getNoteById }))
vi.mock('../../../vault/journal', () => ({
  readJournalEntry: mocks.readJournalEntry,
  readJournalFile: mocks.readJournalFile
}))

import type { IndexDb } from '../../../database'
import { readStoredJournalEntry, readStoredNote } from './stored-records'

describe('stored records spell dates as the file does', () => {
  it('turns the index encoding of a note date back into the file spelling', async () => {
    mocks.getNoteById.mockResolvedValue({
      id: 'n1',
      title: 'Plan',
      path: 'notes/Plan.md',
      tags: [],
      content: 'Body.',
      frontmatter: {},
      properties: { due: '"2026-10-07T00:00:00.000Z"', at: '"2026-09-01T08:30:00.000Z"' }
    })

    const stored = await readStoredNote({} as IndexDb, 'n1', () => null)

    expect(stored?.properties).toEqual({ due: '2026-10-07', at: '2026-09-01T08:30:00.000Z' })
  })

  it('spells a journal date property as the file does', async () => {
    mocks.readJournalEntry.mockResolvedValue({
      id: 'j1',
      date: '2025-02-02',
      tags: [],
      properties: { due: new Date('2025-03-01T00:00:00.000Z') }
    })
    mocks.readJournalFile.mockResolvedValue({ frontmatter: {}, body: 'Body.' })

    const stored = await readStoredJournalEntry('2025-02-02')

    expect(stored?.properties).toEqual({ due: '2025-03-01' })
  })
})
