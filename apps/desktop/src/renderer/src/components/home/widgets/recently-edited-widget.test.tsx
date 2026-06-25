import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecentlyEditedWidget } from './recently-edited-widget'

vi.mock('@/hooks/use-notes-query', () => ({
  useNotesList: () => ({
    notes: [
      {
        id: 'n1',
        path: 'notes/alpha.md',
        title: 'Alpha',
        created: new Date(),
        modified: new Date(),
        tags: [],
        wordCount: 0
      },
      {
        id: 'n2',
        path: 'notes/beta.md',
        title: 'Beta',
        created: new Date(),
        modified: new Date(),
        tags: [],
        wordCount: 0
      },
      {
        id: 'n3',
        path: 'notes/Work/gamma.md',
        title: 'Gamma',
        created: new Date(),
        modified: new Date(),
        tags: [],
        wordCount: 0
      }
    ],
    isLoading: false
  })
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

describe('RecentlyEditedWidget', () => {
  it('lists recent notes', () => {
    render(<RecentlyEditedWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('shows the folder in the row subtitle', () => {
    render(<RecentlyEditedWidget config={{}} size="M" />)
    expect(screen.getByText(/Work · edited/)).toBeInTheDocument()
  })
})
