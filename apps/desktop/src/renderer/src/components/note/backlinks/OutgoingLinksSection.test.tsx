import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NoteLink } from '@memry/contracts/notes-api'
import { OutgoingLinksSection } from './OutgoingLinksSection'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'outgoingLinks.summary') return `${values?.count} outgoing`
      if (key === 'outgoingLinks.more') return `${values?.count} more`
      return key.split('.').at(-1) ?? key
    }
  })
}))

function link(targetTitle: string, targetId: string | null): NoteLink {
  return { sourceId: 'source', targetId, targetTitle }
}

function rowLabels(): string[] {
  return within(screen.getByRole('list'))
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
}

describe('OutgoingLinksSection', () => {
  it('lists every outgoing link alphabetically and marks unresolved targets', () => {
    render(
      <OutgoingLinksSection
        links={[link('Zeta', 'note-z'), link('Alpha', null), link('Mid', 'note-m')]}
        onLinkClick={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '3 outgoing' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(rowLabels()).toEqual(['Alpha unresolved', 'Mid', 'Zeta'])
  })

  it('hands the clicked link title to onLinkClick, resolved or not', () => {
    const onLinkClick = vi.fn()
    render(
      <OutgoingLinksSection
        links={[link('Existing', 'note-e'), link('Missing', null)]}
        onLinkClick={onLinkClick}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Missing unresolved' }))
    fireEvent.click(screen.getByRole('button', { name: 'Existing' }))

    expect(onLinkClick.mock.calls).toEqual([['Missing'], ['Existing']])
  })

  it('collapses the list from its header', () => {
    render(<OutgoingLinksSection links={[link('Only', 'note-o')]} onLinkClick={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '1 outgoing' }))

    expect(screen.getByRole('button', { name: '1 outgoing' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByRole('button', { name: 'Only' })).toBeNull()
  })

  it('shows the first page and reveals the rest on demand', () => {
    const links = ['A', 'B', 'C', 'D'].map((title) => link(title, `note-${title}`))
    render(<OutgoingLinksSection links={links} initialCount={2} onLinkClick={vi.fn()} />)

    expect(rowLabels()).toEqual(['A', 'B'])

    fireEvent.click(screen.getByRole('button', { name: 'showMore' }))

    expect(rowLabels()).toEqual(['A', 'B', 'C', 'D'])
    expect(screen.queryByRole('button', { name: 'showMore' })).toBeNull()
  })

  it('renders nothing for a note without outgoing links', () => {
    const { container, rerender } = render(
      <OutgoingLinksSection links={[link('Here', 'note-h')]} onLinkClick={vi.fn()} />
    )
    expect(container).not.toBeEmptyDOMElement()

    rerender(<OutgoingLinksSection links={[]} onLinkClick={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })
})
