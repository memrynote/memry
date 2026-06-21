import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InboxWidget } from './inbox-widget'

const archiveMutate = vi.fn()

let mockItems: Array<{ id: string; type: string; title: string }> = []

vi.mock('@/hooks/use-inbox-queries', () => ({
  useInboxList: () => ({ items: mockItems, isLoading: false })
}))

vi.mock('@/hooks/use-inbox-mutations', () => ({
  useArchiveInboxItem: () => ({ mutate: archiveMutate })
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

describe('InboxWidget', () => {
  beforeEach(() => {
    archiveMutate.mockClear()
    mockItems = [
      { id: 'i1', type: 'link', title: 'Alpha' },
      { id: 'i2', type: 'note', title: 'Beta' },
      { id: 'i3', type: 'image', title: 'Gamma' },
      { id: 'i4', type: 'voice', title: 'Delta' }
    ]
  })

  it('lists inbox items', () => {
    render(<InboxWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('respects size limit (S slices to 3)', () => {
    render(<InboxWidget config={{}} size="S" />)
    expect(screen.getAllByTestId('inbox-item')).toHaveLength(3)
    expect(screen.queryByText('Delta')).not.toBeInTheDocument()
  })

  it('archive button calls the mutation with the item id', () => {
    render(<InboxWidget config={{}} size="M" />)
    screen.getAllByTestId('inbox-archive')[0].click()
    expect(archiveMutate).toHaveBeenCalledWith('i1')
  })

  it('renders an empty state when there are no items', () => {
    mockItems = []
    render(<InboxWidget config={{}} size="M" />)
    expect(screen.queryByTestId('inbox-item')).not.toBeInTheDocument()
    expect(screen.getByText('No items yet')).toBeInTheDocument()
  })
})
