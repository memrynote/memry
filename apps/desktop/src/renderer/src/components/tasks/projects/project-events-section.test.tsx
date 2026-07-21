import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProjectEventsSection } from './project-events-section'

const { mockListProjectLinks, mockUnlinkProjectItem, mockGetEvent } = vi.hoisted(() => ({
  mockListProjectLinks: vi.fn(),
  mockUnlinkProjectItem: vi.fn(),
  mockGetEvent: vi.fn()
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjectLinks: mockListProjectLinks,
    unlinkProjectItem: mockUnlinkProjectItem
  }
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: {
    getEvent: mockGetEvent
  }
}))

describe('ProjectEventsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUnlinkProjectItem.mockResolvedValue({ success: true })
  })

  it('renders linked events and unlinks on click', async () => {
    mockListProjectLinks.mockResolvedValue([
      {
        id: 'link-1',
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'e1',
        position: 0,
        createdAt: ''
      },
      { id: 'link-2', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 1, createdAt: '' }
    ])
    mockGetEvent.mockResolvedValue({
      id: 'e1',
      title: 'Kickoff',
      startAt: '2026-08-01T10:00:00Z',
      isAllDay: false
    })

    render(<ProjectEventsSection projectId="p1" />)

    expect(await screen.findByText('Kickoff')).toBeInTheDocument()
    expect(mockGetEvent).toHaveBeenCalledTimes(1)
    expect(mockGetEvent).toHaveBeenCalledWith('e1')

    fireEvent.click(screen.getByLabelText('Remove from project'))

    await waitFor(() =>
      expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'e1'
      })
    )
  })

  it('skips links whose event no longer resolves (orphaned link)', async () => {
    mockListProjectLinks.mockResolvedValue([
      {
        id: 'link-1',
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'e1',
        position: 0,
        createdAt: ''
      }
    ])
    mockGetEvent.mockResolvedValue(null)

    const { container } = render(<ProjectEventsSection projectId="p1" />)

    await waitFor(() => expect(mockGetEvent).toHaveBeenCalledWith('e1'))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('renders nothing when the project has no linked events', async () => {
    mockListProjectLinks.mockResolvedValue([])

    const { container } = render(<ProjectEventsSection projectId="p1" />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(mockListProjectLinks).toHaveBeenCalledWith('p1')
  })
})
