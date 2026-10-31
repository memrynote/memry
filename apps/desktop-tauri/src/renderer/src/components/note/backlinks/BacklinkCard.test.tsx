import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BacklinkCard } from './BacklinkCard'
import type { Backlink } from './types'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'backlinks.viaProperty') return `${values?.property} → ${values?.title}`
      if (key === 'backlinks.fromAria') return `Backlinks from ${values?.title}`
      if (key === 'canvasLinks.connectedOn') return `Connected on ${values?.canvas}`
      if (key === 'backlinks.more') return `${values?.count} more`
      return key.split('.').at(-1) ?? key
    }
  })
}))

const baseBacklink: Backlink = {
  id: 'note-a',
  noteId: 'note-a',
  noteTitle: 'John',
  date: new Date('2026-05-08'),
  mentions: [],
  mentionCount: 0,
  truncated: false
}

describe('BacklinkCard', () => {
  it('renders the source title unchanged for a wiki-link entry', () => {
    render(<BacklinkCard backlink={baseBacklink} onClick={vi.fn()} />)

    expect(screen.getByRole('link', { name: 'John' })).toBeInTheDocument()
    expect(screen.queryByText(/→/)).not.toBeInTheDocument()
  })

  it('labels a property-sourced entry as "<property> → <source title>"', () => {
    const propertyBacklink: Backlink = {
      ...baseBacklink,
      via: { kind: 'property', propertyName: 'father' }
    }

    render(<BacklinkCard backlink={propertyBacklink} onClick={vi.fn()} />)

    expect(screen.getByRole('link', { name: 'father → John' })).toBeInTheDocument()
  })

  it('keeps the source title for a canvas entry and names the canvas beside it', () => {
    const canvasBacklink: Backlink = {
      ...baseBacklink,
      via: { kind: 'canvas', canvasId: 'c1', canvasTitle: 'Family map' }
    }

    render(<BacklinkCard backlink={canvasBacklink} onClick={vi.fn()} />)

    expect(screen.getByRole('link', { name: 'John' })).toBeInTheDocument()
    expect(screen.getByText('Connected on Family map')).toBeInTheDocument()
  })

  it('offers no expand toggle when there are no mentions to reveal', () => {
    render(<BacklinkCard backlink={baseBacklink} onClick={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /expand/i })).not.toBeInTheDocument()
  })

  it('offers the expand toggle when mentions exist', () => {
    const withMentions: Backlink = {
      ...baseBacklink,
      mentions: [{ id: 'm1', snippet: 'see [[John]] here', linkStart: 4, linkEnd: 12 }]
    }

    render(<BacklinkCard backlink={withMentions} onClick={vi.fn()} />)

    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument()
  })

  it('counts every link and says how many have no snippet when the source was cut', () => {
    const dense: Backlink = {
      ...baseBacklink,
      mentions: [
        { id: 'm1', snippet: '[[John]] one', linkStart: 0, linkEnd: 8 },
        { id: 'm2', snippet: '[[John]] two', linkStart: 0, linkEnd: 8 }
      ],
      mentionCount: 30,
      truncated: true
    }

    render(<BacklinkCard backlink={dense} defaultExpanded onClick={vi.fn()} />)

    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.getByText('28 more')).toBeInTheDocument()
  })

  it('names no missing snippets when every link has one', () => {
    const whole: Backlink = {
      ...baseBacklink,
      mentions: [
        { id: 'm1', snippet: '[[John]] one', linkStart: 0, linkEnd: 8 },
        { id: 'm2', snippet: '[[John]] two', linkStart: 0, linkEnd: 8 }
      ],
      mentionCount: 2
    }

    render(<BacklinkCard backlink={whole} defaultExpanded onClick={vi.fn()} />)

    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument()
  })
})
