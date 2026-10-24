import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BacklinksSection } from './BacklinksSection'
import type { Backlink } from './types'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'backlinks.viaProperty') return `${values?.property} → ${values?.title}`
      if (key.endsWith('.summary')) return `${values?.notes} notes, ${values?.references} refs`
      return key.split('.').at(-1) ?? key
    }
  })
}))

// Two entries share the same source note (a wikilink entry and a
// property-relation entry from the same source), with different mention
// counts so a "sort by mentions" re-render flips their relative order —
// exactly the condition under which a shared React key could misassociate
// their independent isExpanded state. A third, unrelated entry rounds out
// the list.
function buildBacklinks(): Backlink[] {
  return [
    {
      id: 'note-a',
      noteId: 'note-a',
      noteTitle: 'Zulu',
      date: new Date('2026-05-10'),
      mentions: [{ id: 'm1', snippet: 'WIKI mention text', linkStart: 0, linkEnd: 4 }]
    },
    {
      id: 'note-a:property:father',
      noteId: 'note-a',
      noteTitle: 'Zulu',
      date: new Date('2026-05-10'),
      via: { kind: 'property', propertyName: 'father' },
      mentions: [
        { id: 'm2', snippet: 'PROPERTY mention text', linkStart: 0, linkEnd: 8 },
        { id: 'm2b', snippet: 'PROPERTY mention text two', linkStart: 0, linkEnd: 8 }
      ]
    },
    {
      id: 'note-b',
      noteId: 'note-b',
      noteTitle: 'Alpha',
      date: new Date('2026-05-01'),
      mentions: [{ id: 'm3', snippet: 'other mention', linkStart: 0, linkEnd: 5 }]
    }
  ]
}

describe('BacklinksSection — two entries sharing a sourceId', () => {
  it('keeps each entry independently expandable across a sort-triggered re-render', () => {
    const backlinks = buildBacklinks()

    const { rerender } = render(
      <BacklinksSection backlinks={backlinks} sortBy="recent" onBacklinkClick={vi.fn()} />
    )

    // Both same-source entries default-expand (first two by recency).
    expect(screen.getByText('WIKI mention text')).toBeInTheDocument()
    expect(screen.getByText('PROPERTY mention text')).toBeInTheDocument()

    // Collapse only the property-sourced entry so the two entries end up in
    // different expand states.
    fireEvent.click(screen.getByRole('button', { name: 'collapse father → Zulu' }))
    expect(screen.getByText('WIKI mention text')).toBeInTheDocument()
    expect(screen.queryByText('PROPERTY mention text')).not.toBeInTheDocument()

    // Trigger a re-render that reorders the list: switching to a mentions
    // sort flips the two same-source entries' relative order (the property
    // entry has 2 mentions vs the wiki entry's 1).
    rerender(<BacklinksSection backlinks={backlinks} sortBy="mentions" onBacklinkClick={vi.fn()} />)

    // If the two same-source entries shared a React key, this reorder could
    // misassociate their expand state. It must not: the wiki entry (never
    // touched) stays expanded, the property entry (explicitly collapsed)
    // stays collapsed.
    expect(screen.getByText('WIKI mention text')).toBeInTheDocument()
    expect(screen.queryByText('PROPERTY mention text')).not.toBeInTheDocument()

    // Expanding the still-collapsed property entry after the reorder must
    // only affect that entry, not the wiki entry.
    fireEvent.click(screen.getByRole('button', { name: 'expand father → Zulu' }))
    expect(screen.getByText('WIKI mention text')).toBeInTheDocument()
    expect(screen.getByText('PROPERTY mention text')).toBeInTheDocument()
  })
})
