import { describe, expect, it } from 'vitest'

import { applyInsertAtCursor } from './insert-at-cursor-handler'

describe('applyInsertAtCursor', () => {
  it('hands text and a wiki-link to the open note editor and confirms', () => {
    const inserted: { noteId: string; content: unknown[] }[] = []

    const response = applyInsertAtCursor(
      {
        noteId: 'note-1',
        items: [
          { type: 'text', text: 'See ' },
          { type: 'wikilink', title: 'Plan' }
        ]
      },
      (noteId, content) => {
        inserted.push({ noteId, content })
        return true
      }
    )

    expect(response).toEqual({ ok: true })
    expect(inserted).toHaveLength(1)
    expect(inserted[0].noteId).toBe('note-1')
    expect(inserted[0].content[0]).toBe('See ')
    expect(inserted[0].content[1]).toMatchObject({
      type: 'wikiLink',
      props: { target: 'Plan' }
    })
  })

  it('reports not-open when no editor holds the note', () => {
    const response = applyInsertAtCursor(
      { noteId: 'note-1', items: [{ type: 'text', text: 'x' }] },
      () => false
    )

    expect(response).toEqual({ ok: false, reason: 'not-open' })
  })
})
