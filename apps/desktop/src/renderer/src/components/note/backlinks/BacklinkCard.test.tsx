import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BacklinkCard } from './BacklinkCard'
import type { Backlink } from './types'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'backlinks.viaProperty') return `${values?.property} → ${values?.title}`
      if (key === 'backlinks.fromAria') return `Backlinks from ${values?.title}`
      return key.split('.').at(-1) ?? key
    }
  })
}))

const baseBacklink: Backlink = {
  id: 'note-a',
  noteId: 'note-a',
  noteTitle: 'John',
  date: new Date('2026-05-08'),
  mentions: []
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
})
