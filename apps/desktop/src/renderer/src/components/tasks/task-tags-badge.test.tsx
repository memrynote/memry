import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TaskTagsBadge } from './task-badges'

// The definition is stored lowercase ('mit') while the task carries 'MIT' —
// this asymmetry is what the case-insensitive lookup test below exercises.
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({
    tags: [{ tag: 'mit', count: 3, color: 'red', icon: '📚' }]
  })
}))

describe('TaskTagsBadge', () => {
  it('renders a chip per tag', () => {
    render(<TaskTagsBadge tags={['MIT', 'work']} />)
    expect(screen.getByText('MIT')).toBeInTheDocument()
    expect(screen.getByText('work')).toBeInTheDocument()
  })

  it('renders nothing when there are no tags', () => {
    const { container } = render(<TaskTagsBadge tags={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a +N overflow badge past maxVisible', () => {
    render(<TaskTagsBadge tags={['a', 'b', 'c', 'd']} maxVisible={2} />)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
    expect(screen.queryByText('c')).not.toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('resolves the definition case-insensitively and keeps the typed case', () => {
    render(<TaskTagsBadge tags={['MIT']} />)
    // Display keeps the case the user typed...
    expect(screen.getByText('MIT')).toBeInTheDocument()
    // ...while the icon proves the lowercase 'mit' definition was actually
    // found. Asserting only on the label would pass even with a broken
    // lookup, since the label comes from the task's tag string.
    expect(screen.getByText('📚')).toBeInTheDocument()
  })
})
