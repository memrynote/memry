import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NoteCardKindIcon } from './note-card-pieces'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

describe('NoteCardKindIcon', () => {
  it('marks a task row with a task icon', () => {
    render(<NoteCardKindIcon kind="task" />)
    expect(screen.getByTestId('kind-icon-task')).toBeInTheDocument()
  })

  it('marks an inbox row with an inbox icon', () => {
    render(<NoteCardKindIcon kind="inbox" />)
    expect(screen.getByTestId('kind-icon-inbox')).toBeInTheDocument()
  })

  it('renders nothing for a plain note, which needs no disambiguation', () => {
    const { container } = render(<NoteCardKindIcon kind={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when kind is explicitly "note"', () => {
    const { container } = render(<NoteCardKindIcon kind="note" />)
    expect(container).toBeEmptyDOMElement()
  })
})
