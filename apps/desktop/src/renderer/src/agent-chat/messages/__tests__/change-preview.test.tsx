import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ChangePreview } from '@memry/contracts/ipc-agent'

import { ChangePreviewView, buildBodyChunks } from '../change-preview'

function preview(overrides: Partial<ChangePreview> = {}): ChangePreview {
  return {
    kind: 'fields',
    item: { type: 'task', id: 'task-1', title: 'Ship the preview API', context: 'Memry' },
    intent: 'update',
    fields: [],
    body: null,
    loss: [],
    destructive: false,
    ...overrides
  }
}

describe('ChangePreviewView', () => {
  it('names the item, its type and what is being done to it', () => {
    render(<ChangePreviewView preview={preview()} />)

    expect(screen.getByText('Ship the preview API')).toBeInTheDocument()
    expect(screen.getByText('Task')).toBeInTheDocument()
    expect(screen.getByText('Memry')).toBeInTheDocument()
    expect(screen.getByText('update')).toBeInTheDocument()
  })

  it('renders a field change as a before and an after', () => {
    render(
      <ChangePreviewView
        preview={preview({
          fields: [{ key: 'due_date', before: '2026-10-12', after: '2026-10-15' }]
        })}
      />
    )

    expect(screen.getByText('Due')).toBeInTheDocument()
    expect(screen.getByText('2026-10-12')).toBeInTheDocument()
    expect(screen.getByText('2026-10-15')).toBeInTheDocument()
  })

  /**
   * A blank cell is indistinguishable from a value the card failed to load, so
   * an unset field has to say so in words.
   */
  it('says not set rather than leaving a field blank', () => {
    render(
      <ChangePreviewView
        preview={preview({ fields: [{ key: 'priority', before: null, after: '2' }] })}
      />
    )

    expect(screen.getByText('not set')).toBeInTheDocument()
  })

  it('reads a boolean field as a word', () => {
    render(
      <ChangePreviewView
        preview={preview({ fields: [{ key: 'is_done', before: 'false', after: 'true' }] })}
      />
    )

    expect(screen.getByText('Done state')).toBeInTheDocument()
    expect(screen.getByText('no')).toBeInTheDocument()
    expect(screen.getByText('yes')).toBeInTheDocument()
  })

  it('highlights the changed words inside a body, not the whole paragraph', () => {
    render(
      <ChangePreviewView
        preview={preview({
          kind: 'body',
          item: { type: 'note', id: 'note-1', title: 'Q4 planning', context: null },
          body: {
            current: 'Hiring stays paused until the next board review.',
            candidate: 'Hiring stays paused until 15 November.'
          }
        })}
      />
    )

    const added = document.querySelectorAll('ins')
    const removed = document.querySelectorAll('del')
    expect(added.length).toBeGreaterThan(0)
    expect(removed.length).toBeGreaterThan(0)
    expect(screen.getByText(/Hiring stays paused until/)).toBeInTheDocument()
  })

  it('names what a delete would take instead of showing an empty after', () => {
    render(
      <ChangePreviewView
        preview={preview({
          kind: 'loss',
          intent: 'delete',
          destructive: true,
          loss: ['words:412', 'tags:2', 'excerpt:Slept badly.']
        })}
      />
    )

    expect(screen.getByText('Will be lost')).toBeInTheDocument()
    expect(screen.getByText('Slept badly.')).toBeInTheDocument()
    expect(screen.getByText('412 words · 2 tags')).toBeInTheDocument()
  })

  /**
   * Silence would read as a broken preview, so a write that moves nothing the
   * card can name has to say that in words.
   */
  it('says so when there is nothing to show', () => {
    render(<ChangePreviewView preview={preview()} />)

    expect(screen.getByText('Nothing this preview can name would change.')).toBeInTheDocument()
  })
})

describe('buildBodyChunks', () => {
  it('collapses a long untouched run instead of drawing it', () => {
    const current = ['one', 'two', 'three', 'four', 'five', 'six', 'tail'].join('\n')
    const candidate = ['one', 'two', 'three', 'four', 'five', 'six', 'changed tail'].join('\n')

    const chunks = buildBodyChunks(current, candidate)

    expect(chunks[0]).toEqual({ kind: 'collapsed', lines: 6 })
    expect(chunks.at(-1)).toMatchObject({ kind: 'changed' })
  })

  /**
   * A replacement arrives from jsdiff as removed-then-added. Pairing the two is
   * what lets the word diff run; without it the card shows two opaque blocks.
   */
  it('pairs a removal with the addition that replaces it', () => {
    const chunks = buildBodyChunks('before text\n', 'after text\n')

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({
      kind: 'changed',
      removed: 'before text\n',
      added: 'after text\n'
    })
  })

  it('reports an append as an addition with no removal', () => {
    const chunks = buildBodyChunks('kept\n', 'kept\nadded\n')

    expect(chunks[0]).toEqual({ kind: 'context', text: 'kept\n' })
    expect(chunks[1]).toEqual({ kind: 'changed', removed: '', added: 'added\n' })
  })
})
