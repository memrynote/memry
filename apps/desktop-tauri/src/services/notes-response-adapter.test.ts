import { describe, expect, it } from 'vitest'
import { reviveNoteDates } from './notes-response-adapter'

describe('reviveNoteDates', () => {
  it('converts ISO `created` and `modified` strings on a single note', () => {
    const dto = {
      id: 'note-1',
      title: 'Hi',
      created: '2026-04-26T10:00:00.000Z',
      modified: '2026-04-26T11:00:00.000Z',
      tags: ['work']
    }

    const revived = reviveNoteDates(dto)

    expect(revived.created).toBeInstanceOf(Date)
    expect(revived.modified).toBeInstanceOf(Date)
    expect((revived.created as Date).toISOString()).toBe('2026-04-26T10:00:00.000Z')
  })

  it('walks arrays and nested envelopes (NoteListResponse, NoteCreateResponse)', () => {
    const listResponse = {
      notes: [
        {
          id: 'a',
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-02T00:00:00.000Z'
        },
        {
          id: 'b',
          created: '2026-02-01T00:00:00.000Z',
          modified: '2026-02-02T00:00:00.000Z'
        }
      ],
      total: 2,
      hasMore: false
    }

    const revived = reviveNoteDates(listResponse) as typeof listResponse

    expect(revived.notes[0].created).toBeInstanceOf(Date)
    expect(revived.notes[1].modified).toBeInstanceOf(Date)
    expect(revived.total).toBe(2)
    expect(revived.hasMore).toBe(false)
  })

  it('passes through null, undefined, primitives unchanged', () => {
    expect(reviveNoteDates(null)).toBeNull()
    expect(reviveNoteDates(undefined)).toBeUndefined()
    expect(reviveNoteDates('hello')).toBe('hello')
    expect(reviveNoteDates(42)).toBe(42)
  })

  it('leaves non-date string fields alone', () => {
    const dto = {
      id: 'x',
      title: 'Title',
      snippet: '2026-04-26T00:00:00.000Z'
    }

    const revived = reviveNoteDates(dto) as typeof dto

    expect(revived.snippet).toBe('2026-04-26T00:00:00.000Z')
    expect(typeof revived.snippet).toBe('string')
  })

  it('preserves already-Date values without double-wrapping', () => {
    const original = new Date('2026-04-26T00:00:00.000Z')
    const dto = { id: 'x', created: original, modified: original }

    const revived = reviveNoteDates(dto) as typeof dto

    expect(revived.created).toBe(original)
    expect(revived.modified).toBe(original)
  })
})
