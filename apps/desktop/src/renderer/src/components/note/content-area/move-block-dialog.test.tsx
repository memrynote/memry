/**
 * The block side menu's "Move to" picker offers only notes a block can land
 * in: an image, PDF, audio or video file is refused by main, so it is not
 * offered (#5607 item 4).
 */

import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MoveBlockDialog } from './move-block-dialog'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

// The picker keeps the highlighted row in view; jsdom has no scroller.
Element.prototype.scrollIntoView = vi.fn()

const list = vi.fn()

afterEach(() => {
  list.mockReset()
})

const row = (id: string, path: string, fileType?: string) => ({
  id,
  path,
  title: id,
  created: new Date(0),
  modified: new Date(0),
  tags: [],
  wordCount: null,
  ...(fileType ? { fileType } : {})
})

describe('MoveBlockDialog', () => {
  it('offers markdown notes and leaves out binary files and the source note', async () => {
    const api = window.api as unknown as Record<string, Record<string, unknown> | undefined>
    api.notes = { ...api.notes, list }
    list.mockResolvedValue({
      notes: [
        row('source', 'notes/source.md', 'markdown'),
        row('target', 'notes/target.md', 'markdown'),
        row('photo', 'attachments/host/pasted.png', 'image'),
        row('paper', 'papers/paper.pdf', 'pdf'),
        // A binary row an older build saved as markdown (#5412).
        row('retyped', 'notes/clip.mp4', 'markdown')
      ],
      total: 5,
      hasMore: false
    })

    render(
      <MoveBlockDialog open onOpenChange={vi.fn()} currentNoteId="source" onSelect={vi.fn()} />
    )

    const options = (): string[] =>
      [...document.querySelectorAll('[data-test="move-block-option"]')].map(
        (option) => option.textContent ?? ''
      )
    await waitFor(() => expect(options()).toEqual(['targetnotes/target.md']))
  })
})
