import { describe, expect, it } from 'vitest'
import { selectLargeNotes, type LargeNoteRow } from './large-notes'
import { NOTE_SYNC_MAX_BYTES, NOTE_SYNC_WARN_BYTES } from './note-size'

function row(overrides: Partial<LargeNoteRow> & { id: string }): LargeNoteRow {
  return {
    title: overrides.id,
    path: `${overrides.id}.md`,
    fileType: 'markdown',
    localOnly: false,
    ...overrides
  }
}

describe('selectLargeNotes', () => {
  it('#then it reports a note over the ceiling as already broken', () => {
    const sizes = new Map([['big.md', NOTE_SYNC_MAX_BYTES + 1]])

    const result = selectLargeNotes(
      [row({ id: 'big', title: 'Server log dump', path: 'big.md' })],
      (p) => sizes.get(p) ?? null
    )

    expect(result).toEqual([
      {
        id: 'big',
        title: 'Server log dump',
        path: 'big.md',
        sizeBytes: NOTE_SYNC_MAX_BYTES + 1,
        status: 'over'
      }
    ])
  })

  it('#then it warns about a note still under the ceiling', () => {
    const result = selectLargeNotes([row({ id: 'growing' })], () => NOTE_SYNC_WARN_BYTES)

    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('approaching')
  })

  it('#then an ordinary note is not listed', () => {
    const result = selectLargeNotes([row({ id: 'normal' })], () => 2_048)

    expect(result).toEqual([])
  })

  it('#then it ranks the largest note first', () => {
    const sizes = new Map([
      ['a.md', NOTE_SYNC_WARN_BYTES],
      ['b.md', NOTE_SYNC_MAX_BYTES + 5_000],
      ['c.md', NOTE_SYNC_MAX_BYTES]
    ])

    const result = selectLargeNotes(
      [
        row({ id: 'a', path: 'a.md' }),
        row({ id: 'b', path: 'b.md' }),
        row({ id: 'c', path: 'c.md' })
      ],
      (p) => sizes.get(p) ?? null
    )

    expect(result.map((n) => n.id)).toEqual(['b', 'c', 'a'])
  })

  it('#then attachments are excluded — the plan file limit governs those, not this ceiling', () => {
    const result = selectLargeNotes(
      [row({ id: 'movie', path: 'movie.mp4', fileType: 'video' })],
      () => NOTE_SYNC_MAX_BYTES * 2
    )

    expect(result).toEqual([])
  })

  it('#then a local-only note is excluded because it never syncs', () => {
    const result = selectLargeNotes(
      [row({ id: 'scratch', localOnly: true })],
      () => NOTE_SYNC_MAX_BYTES + 1
    )

    expect(result).toEqual([])
  })

  it('#then a note whose file cannot be measured is skipped rather than guessed at', () => {
    const result = selectLargeNotes([row({ id: 'gone' })], () => null)

    expect(result).toEqual([])
  })
})
