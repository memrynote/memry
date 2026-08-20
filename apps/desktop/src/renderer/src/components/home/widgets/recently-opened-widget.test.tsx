import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecentlyOpenedWidget } from './recently-opened-widget'

vi.mock('@/hooks/use-recently-opened', () => ({
  useRecentlyOpened: () => ({
    items: [
      {
        itemId: 'n1',
        itemType: 'note',
        openedAt: new Date().toISOString(),
        title: 'Alpha',
        path: 'notes/alpha.md',
        emoji: null,
        fileType: 'markdown'
      },
      {
        itemId: 'n2',
        itemType: 'note',
        openedAt: new Date().toISOString(),
        title: 'Gamma',
        path: 'notes/Work/gamma.md',
        emoji: null,
        fileType: 'markdown'
      }
    ],
    isLoading: false,
    error: null
  })
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

describe('RecentlyOpenedWidget', () => {
  it('lists recently opened notes', () => {
    render(<RecentlyOpenedWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  // The two Home widgets sit side by side and can hold the same note; the verb
  // in the row subtitle is what tells "opened" apart from "edited".
  it('labels rows as opened, not edited', () => {
    render(<RecentlyOpenedWidget config={{}} size="M" />)
    expect(screen.getByText(/Work · opened/)).toBeInTheDocument()
    expect(screen.queryByText(/edited/)).not.toBeInTheDocument()
  })
})
