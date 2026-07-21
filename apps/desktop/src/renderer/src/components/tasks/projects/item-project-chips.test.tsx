import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemProjectChips } from './item-project-chips'

const { mockListForItem, mockOnProjectUpdated } = vi.hoisted(() => ({
  mockListForItem: vi.fn(),
  mockOnProjectUpdated: vi.fn(() => () => {})
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listForItem: mockListForItem
  },
  onProjectUpdated: mockOnProjectUpdated
}))

describe('ItemProjectChips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnProjectUpdated.mockReturnValue(() => {})
  })

  it('renders a chip per linked project', async () => {
    mockListForItem.mockResolvedValue([
      { id: 'p1', name: 'Launch', color: '#f00', icon: null },
      { id: 'p2', name: 'Finance', color: '#0f0', icon: null }
    ])

    render(<ItemProjectChips itemType="note" itemId="n1" />)

    expect(await screen.findByText('Launch')).toBeInTheDocument()
    expect(screen.getByText('Finance')).toBeInTheDocument()
    expect(mockListForItem).toHaveBeenCalledWith('note', 'n1')
  })

  it('renders nothing when there are no linked projects', async () => {
    mockListForItem.mockResolvedValue([])

    const { container } = render(<ItemProjectChips itemType="note" itemId="n1" />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('calls onProjectClick with the project id when a chip is clicked', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#f00', icon: null }])
    const onProjectClick = vi.fn()

    render(<ItemProjectChips itemType="note" itemId="n1" onProjectClick={onProjectClick} />)

    fireEvent.click(await screen.findByText('Launch'))

    expect(onProjectClick).toHaveBeenCalledWith('p1')
  })

  it('treats an IPC error envelope as empty instead of throwing (union guard)', async () => {
    // withDb wrapper can resolve { success: false, error } instead of rejecting.
    mockListForItem.mockResolvedValue({ success: false, error: 'db error' })

    const { container } = render(<ItemProjectChips itemType="note" itemId="n1" />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('refetches when a project update event fires', async () => {
    mockListForItem
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'p1', name: 'Launch', color: '#f00', icon: null }])
    let updateHandler: (() => void) | undefined
    mockOnProjectUpdated.mockImplementation((cb: () => void) => {
      updateHandler = cb
      return () => {}
    })

    const { container } = render(<ItemProjectChips itemType="note" itemId="n1" />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())

    updateHandler?.()

    expect(await screen.findByText('Launch')).toBeInTheDocument()
    expect(mockListForItem).toHaveBeenCalledTimes(2)
  })
})
