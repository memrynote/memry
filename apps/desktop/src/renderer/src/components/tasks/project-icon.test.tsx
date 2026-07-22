import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProjectIcon } from './project-icon'

// Legacy lucide resolver: only PascalCase names in the curated map resolve.
vi.mock('@/components/icon-picker', () => ({
  getIconByName: (name: string) =>
    name === 'Folder' || name === 'Star'
      ? (props: { className?: string; style?: React.CSSProperties }) => (
          <span data-testid="lucide" className={props.className} style={props.style}>
            {name}
          </span>
        )
      : undefined
}))

// The shared renderer: icon: values → huge icon, else raw text in a span.
vi.mock('@/lib/render-note-icon', () => ({
  NoteIconDisplay: ({ value, className }: { value: string; className?: string }) => (
    <span data-testid="note-icon" data-value={value} className={className}>
      {value}
    </span>
  )
}))

const DOT = <span data-testid="fallback">dot</span>

describe('ProjectIcon', () => {
  it('renders a legacy bare lucide name as the lucide glyph, tinted', () => {
    render(<ProjectIcon icon="Folder" className="size-4" color="#11aa55" fallback={DOT} />)

    const glyph = screen.getByTestId('lucide')
    expect(glyph).toHaveTextContent('Folder')
    expect(glyph).toHaveStyle({ color: '#11aa55' })
    expect(screen.queryByTestId('note-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fallback')).not.toBeInTheDocument()
  })

  it('renders a new "icon:Name" value through NoteIconDisplay, marked decorative', () => {
    render(<ProjectIcon icon="icon:StarIcon" className="size-6" fallback={DOT} />)

    const icon = screen.getByTestId('note-icon')
    expect(icon).toHaveAttribute('data-value', 'icon:StarIcon')
    // Decorative: the project name is the accessible label, so the glyph is hidden.
    expect(icon.closest('[aria-hidden="true"]')).toBeInTheDocument()
    expect(screen.queryByTestId('lucide')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fallback')).not.toBeInTheDocument()
  })

  it('renders a raw emoji through NoteIconDisplay, marked decorative', () => {
    render(<ProjectIcon icon="📚" fallback={DOT} />)

    const icon = screen.getByTestId('note-icon')
    expect(icon).toHaveAttribute('data-value', '📚')
    expect(icon.closest('[aria-hidden="true"]')).toBeInTheDocument()
    expect(screen.queryByTestId('fallback')).not.toBeInTheDocument()
  })

  it('renders the fallback for null', () => {
    render(<ProjectIcon icon={null} fallback={DOT} />)

    expect(screen.getByTestId('fallback')).toBeInTheDocument()
    expect(screen.queryByTestId('note-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('lucide')).not.toBeInTheDocument()
  })

  it('renders the fallback for an unresolved ASCII name (e.g. lowercase "folder")', () => {
    render(<ProjectIcon icon="folder" fallback={DOT} />)

    // Not an icon: value, not in the lucide map, and ASCII → not an emoji glyph.
    expect(screen.getByTestId('fallback')).toBeInTheDocument()
    expect(screen.queryByTestId('note-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('lucide')).not.toBeInTheDocument()
  })
})
