import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemProjectChips } from './item-project-chips'

const { mockListForItem, mockOnProjectUpdated, mockUnlinkProjectItem, mockToastError } = vi.hoisted(
  () => ({
    mockListForItem: vi.fn(),
    // Declares the subscriber parameter the component actually passes, so
    // the mockImplementation below that captures it still typechecks.
    mockOnProjectUpdated: vi.fn((_callback: () => void) => () => {}),
    mockUnlinkProjectItem: vi.fn(),
    mockToastError: vi.fn()
  })
)

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listForItem: mockListForItem,
    unlinkProjectItem: mockUnlinkProjectItem
  },
  onProjectUpdated: mockOnProjectUpdated
}))

vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

describe('ItemProjectChips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnProjectUpdated.mockReturnValue(() => {})
    mockUnlinkProjectItem.mockResolvedValue({ success: true })
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

  // A binary file has no frontmatter, so these chips are the whole of its
  // project membership UI. Without a remove control on them the only exits
  // from a project are destructive (issue #1941).
  it('unlinks the item when a chip remove control is used', async () => {
    mockListForItem
      .mockResolvedValueOnce([{ id: 'p1', name: 'Launch', color: '#f00', icon: null }])
      .mockResolvedValue([])

    render(<ItemProjectChips itemType="file" itemId="f1" />)

    fireEvent.click(await screen.findByRole('button', { name: /remove from launch/i }))

    await waitFor(() =>
      expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'file',
        itemId: 'f1'
      })
    )
    await waitFor(() => expect(screen.queryByText('Launch')).not.toBeInTheDocument())
  })

  it('gives each chip its own remove control, naming the project it drops', async () => {
    mockListForItem.mockResolvedValue([
      { id: 'p1', name: 'Launch', color: '#f00', icon: null },
      { id: 'p2', name: 'Finance', color: '#0f0', icon: null }
    ])

    render(<ItemProjectChips itemType="file" itemId="f1" />)

    fireEvent.click(await screen.findByRole('button', { name: /remove from finance/i }))

    await waitFor(() =>
      expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p2',
        itemType: 'file',
        itemId: 'f1'
      })
    )
  })

  it('renders the name as plain text where there is nowhere to navigate', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#f00', icon: null }])

    render(<ItemProjectChips itemType="file" itemId="f1" />)

    expect(await screen.findByText('Launch')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open project launch/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove from launch/i })).toBeInTheDocument()
  })

  // The main side answers a failed unlink with an envelope rather than a
  // rejection, so a bare await would read it as success and blank the chip.
  it('keeps the chip and reports a rejected unlink', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#f00', icon: null }])
    mockUnlinkProjectItem.mockResolvedValue({ success: false, error: 'link is gone' })

    render(<ItemProjectChips itemType="file" itemId="f1" />)

    fireEvent.click(await screen.findByRole('button', { name: /remove from launch/i }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('link is gone'))
    expect(screen.getByText('Launch')).toBeInTheDocument()
  })
})
