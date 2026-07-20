import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProjectNotesSection } from './project-notes-section'

const { mockListProjectLinks, mockUnlinkProjectItem, mockGetNote } = vi.hoisted(() => ({
  mockListProjectLinks: vi.fn(),
  mockUnlinkProjectItem: vi.fn(),
  mockGetNote: vi.fn()
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjectLinks: mockListProjectLinks,
    unlinkProjectItem: mockUnlinkProjectItem
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: mockGetNote
  }
}))

describe('ProjectNotesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUnlinkProjectItem.mockResolvedValue({ success: true })
  })

  it('renders linked notes and unlinks on click', async () => {
    mockListProjectLinks.mockResolvedValue([
      { id: 'link-1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0, createdAt: '' }
    ])
    mockGetNote.mockResolvedValue({ id: 'n1', title: 'Launch brief' })

    render(<ProjectNotesSection projectId="p1" />)

    expect(await screen.findByText('Launch brief')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Remove from project'))

    await waitFor(() =>
      expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'note',
        itemId: 'n1'
      })
    )
  })

  it('ignores non-note links and removes the card after unlinking', async () => {
    mockListProjectLinks.mockResolvedValue([
      { id: 'link-1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0, createdAt: '' },
      {
        id: 'link-2',
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'e1',
        position: 1,
        createdAt: ''
      }
    ])
    mockGetNote.mockResolvedValue({ id: 'n1', title: 'Launch brief' })

    render(<ProjectNotesSection projectId="p1" />)

    expect(await screen.findByText('Launch brief')).toBeInTheDocument()
    expect(mockGetNote).toHaveBeenCalledTimes(1)
    expect(mockGetNote).toHaveBeenCalledWith('n1')

    fireEvent.click(screen.getByLabelText('Remove from project'))

    await waitFor(() => expect(mockUnlinkProjectItem).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Launch brief')).not.toBeInTheDocument())
  })

  it('renders nothing when the project has no linked notes', async () => {
    mockListProjectLinks.mockResolvedValue([])

    const { container } = render(<ProjectNotesSection projectId="p1" />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(mockListProjectLinks).toHaveBeenCalledWith('p1')
  })
})
