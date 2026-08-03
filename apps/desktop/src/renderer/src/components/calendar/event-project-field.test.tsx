import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EventProjectField } from './event-project-field'

const {
  mockListForItem,
  mockLinkProjectItem,
  mockUnlinkProjectItem,
  mockOnProjectUpdated,
  mockToastError
} = vi.hoisted(() => ({
  mockListForItem: vi.fn(),
  mockLinkProjectItem: vi.fn(),
  mockUnlinkProjectItem: vi.fn(),
  mockOnProjectUpdated: vi.fn(() => () => {}),
  mockToastError: vi.fn()
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listForItem: mockListForItem,
    linkProjectItem: mockLinkProjectItem,
    unlinkProjectItem: mockUnlinkProjectItem
  },
  onProjectUpdated: mockOnProjectUpdated
}))

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() }
}))

// Projects come from the app-wide TasksProvider, same as calendar-task-popover.
vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({
    projects: [
      { id: 'p1', name: 'Launch', color: '#ff0000', icon: null, isArchived: false },
      { id: 'p2', name: 'Finance', color: '#00ff00', icon: null, isArchived: false }
    ]
  })
}))

// The real Picker is Radix Popover-based and does not open on click in jsdom
// (codebase convention: mock it). This passthrough exposes one button per
// option so the field's own orchestration is what gets tested.
vi.mock('@/components/tasks/project-picker', () => ({
  ProjectPicker: ({
    value,
    onChange,
    projects,
    allOptionLabel
  }: {
    value: string | null
    onChange: (id: string | null) => void
    projects: Array<{ id: string; name: string }>
    allOptionLabel?: string
  }) => (
    <div data-testid="project-picker" data-value={value ?? ''}>
      <button type="button" onClick={() => onChange(null)}>
        {allOptionLabel}
      </button>
      {projects.map((project) => (
        <button key={project.id} type="button" onClick={() => onChange(project.id)}>
          {`pick-${project.name}`}
        </button>
      ))}
    </div>
  )
}))

describe('EventProjectField · create mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnProjectUpdated.mockReturnValue(() => {})
  })

  it('renders the picker with the draft value and no IPC call', () => {
    render(<EventProjectField mode="create" value="p1" onChange={vi.fn()} />)

    expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(mockListForItem).not.toHaveBeenCalled()
  })

  it('reports the selected project through onChange without writing links', () => {
    const onChange = vi.fn()
    render(<EventProjectField mode="create" value={null} onChange={onChange} />)

    fireEvent.click(screen.getByText('pick-Launch'))

    expect(onChange).toHaveBeenCalledWith('p1')
    expect(mockLinkProjectItem).not.toHaveBeenCalled()
    expect(mockUnlinkProjectItem).not.toHaveBeenCalled()
  })

  it('reports null when the user picks "No project"', () => {
    const onChange = vi.fn()
    render(<EventProjectField mode="create" value="p1" onChange={onChange} />)

    fireEvent.click(screen.getByText('No project'))

    expect(onChange).toHaveBeenCalledWith(null)
  })
})

describe('EventProjectField · edit mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnProjectUpdated.mockReturnValue(() => {})
    mockListForItem.mockResolvedValue([])
    mockLinkProjectItem.mockResolvedValue({ success: true })
    mockUnlinkProjectItem.mockResolvedValue({ success: true })
  })

  it('loads the current links for the event on mount', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

    await waitFor(() => expect(mockListForItem).toHaveBeenCalledWith('calendar_event', 'evt-1'))
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )
  })

  it('renders nothing when edit mode has no event id yet', () => {
    const { container } = render(
      <EventProjectField mode="edit" eventId={null} value={null} onChange={vi.fn()} />
    )

    expect(container).toBeEmptyDOMElement()
    expect(mockListForItem).not.toHaveBeenCalled()
  })

  it('unlinks the previous project and links the new one when the selection changes', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )

    fireEvent.click(screen.getByText('pick-Finance'))

    await waitFor(() =>
      expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'evt-1'
      })
    )
    expect(mockLinkProjectItem).toHaveBeenCalledWith({
      projectId: 'p2',
      itemType: 'calendar_event',
      itemId: 'evt-1'
    })
  })

  it('only links when the event had no project', async () => {
    mockListForItem.mockResolvedValue([])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalled())

    fireEvent.click(screen.getByText('pick-Launch'))

    await waitFor(() => expect(mockLinkProjectItem).toHaveBeenCalledTimes(1))
    expect(mockUnlinkProjectItem).not.toHaveBeenCalled()
  })

  it('only unlinks when the user picks "No project"', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )

    fireEvent.click(screen.getByText('No project'))

    await waitFor(() =>
      expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'evt-1'
      })
    )
    expect(mockLinkProjectItem).not.toHaveBeenCalled()
  })

  it('never calls onChange in edit mode (the draft does not own the link)', async () => {
    const onChange = vi.fn()
    mockListForItem.mockResolvedValue([])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={onChange} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalled())

    fireEvent.click(screen.getByText('pick-Launch'))

    await waitFor(() => expect(mockLinkProjectItem).toHaveBeenCalled())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('treats an IPC error envelope from listForItem as no links', async () => {
    // Shaped so `links[0]` would resolve to a *real-looking* project if the
    // `Array.isArray` guard were removed and this raw envelope were stored as
    // `links` directly — discriminates the guard instead of merely relying
    // on `links[0]` being safely `undefined` for any non-array object (which
    // it would be regardless of the guard, giving no regression coverage).
    mockListForItem.mockResolvedValue({
      success: false,
      error: 'db error',
      0: { id: 'ghost', name: 'Ghost', color: '#000000', icon: null }
    })

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

    await waitFor(() => expect(mockListForItem).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', '')
    )
  })

  it('falls back to no links when listForItem rejects', async () => {
    mockListForItem.mockRejectedValue(new Error('network error'))

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

    await waitFor(() => expect(mockListForItem).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', '')
    )
  })

  it('shows a toast and reloads when a link write fails', async () => {
    mockListForItem.mockResolvedValue([])
    mockLinkProjectItem.mockResolvedValue({ success: false, error: 'link failed' })

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByText('pick-Launch'))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(2))
  })

  it('shows a toast when a link write rejects outright', async () => {
    mockListForItem.mockResolvedValue([])
    mockLinkProjectItem.mockRejectedValue(new Error('link failed'))

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByText('pick-Launch'))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
  })

  it('ignores a selection made before the initial load resolves', async () => {
    let resolveList: ((value: unknown) => void) | undefined
    mockListForItem.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve
      })
    )

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalled())

    // Clicked while the initial load is still in flight — `links` is still
    // `[]`, so a naive read of `previousId` here would be wrong.
    fireEvent.click(screen.getByText('pick-Launch'))
    expect(mockLinkProjectItem).not.toHaveBeenCalled()

    resolveList?.([])
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', '')
    )
    // The click during the load window was dropped, not queued.
    expect(mockLinkProjectItem).not.toHaveBeenCalled()
  })

  it('ignores a second selection while the first write is still in flight', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])
    let resolveUnlink: ((value: { success: boolean }) => void) | undefined
    mockUnlinkProjectItem.mockReturnValue(
      new Promise((resolve) => {
        resolveUnlink = resolve
      })
    )

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )

    fireEvent.click(screen.getByText('pick-Finance'))
    await waitFor(() => expect(mockUnlinkProjectItem).toHaveBeenCalledTimes(1))

    // Fired before the first selection's unlink settles — `links` still
    // says `p1` is current, so this would issue a second, stale unlink.
    fireEvent.click(screen.getByText('pick-Launch'))

    resolveUnlink?.({ success: true })
    await waitFor(() =>
      expect(mockLinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p2',
        itemType: 'calendar_event',
        itemId: 'evt-1'
      })
    )
    expect(mockUnlinkProjectItem).toHaveBeenCalledTimes(1)
    expect(mockLinkProjectItem).toHaveBeenCalledTimes(1)
  })

  it('reloads when a project update event fires', async () => {
    mockListForItem
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'p2', name: 'Finance', color: '#00ff00', icon: null }])
    let updateHandler: (() => void) | undefined
    mockOnProjectUpdated.mockImplementation((cb: () => void) => {
      updateHandler = cb
      return () => {}
    })

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(1))

    updateHandler?.()

    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p2')
    )
  })
})
