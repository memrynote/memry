import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
// A third project (p3) exists so a stale-state race test can pick a project
// that is neither the current link nor the first race click's target. `p4` is
// archived: the real picker filters archived projects out of its list, so a
// link to one can never be represented by the picker.
vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({
    projects: [
      { id: 'p1', name: 'Launch', color: '#ff0000', icon: null, isArchived: false },
      { id: 'p2', name: 'Finance', color: '#00ff00', icon: null, isArchived: false },
      { id: 'p3', name: 'Marketing', color: '#0000ff', icon: null, isArchived: false },
      { id: 'p4', name: 'Retired', color: '#999999', icon: null, isArchived: true }
    ]
  })
}))

// The real Picker is Radix Popover-based and does not open on click in jsdom
// (codebase convention: mock it). This passthrough exposes one button per
// option so the field's own orchestration is what gets tested. It drops
// archived projects exactly like the real one (project-picker.tsx), which is
// what makes an archived link unrepresentable here.
vi.mock('@/components/tasks/project-picker', () => ({
  ProjectPicker: ({
    value,
    onChange,
    projects,
    allOptionLabel
  }: {
    value: string | null
    onChange: (id: string | null) => void
    projects: Array<{ id: string; name: string; isArchived: boolean }>
    allOptionLabel?: string
  }) => (
    <div data-testid="project-picker" data-value={value ?? ''}>
      <button type="button" onClick={() => onChange(null)}>
        {allOptionLabel}
      </button>
      {projects
        .filter((project) => !project.isArchived)
        .map((project) => (
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

    // Fired before the first selection's unlink settles — `links` still says
    // `p1` is current. Picking a THIRD project (neither the stale `p1` nor
    // the first click's `p2`) means a stale read of `previousId` ('p1')
    // would differ from `nextId` ('p3') and NOT hit the pre-existing
    // "same id, no-op" short-circuit — only the in-flight guard can produce
    // the no-op this test expects.
    fireEvent.click(screen.getByText('pick-Marketing'))

    resolveUnlink?.({ success: true })
    await waitFor(() =>
      expect(mockLinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p2',
        itemType: 'calendar_event',
        itemId: 'evt-1'
      })
    )
    // The second click's selection (p3) was dropped entirely: only the first
    // click's unlink(p1)+link(p2) pair ever went out.
    expect(mockUnlinkProjectItem).toHaveBeenCalledTimes(1)
    expect(mockLinkProjectItem).toHaveBeenCalledTimes(1)
    expect(mockLinkProjectItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p3' })
    )
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

  it('renders extra links as removable chips beside the picker', async () => {
    mockListForItem.mockResolvedValue([
      { id: 'p1', name: 'Launch', color: '#ff0000', icon: null },
      { id: 'p2', name: 'Finance', color: '#00ff00', icon: null }
    ])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )
    expect(await screen.findByText('Finance')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove from Finance' })).toBeInTheDocument()
  })

  it('unlinks only the chip that was removed', async () => {
    mockListForItem.mockResolvedValue([
      { id: 'p1', name: 'Launch', color: '#ff0000', icon: null },
      { id: 'p2', name: 'Finance', color: '#00ff00', icon: null }
    ])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    const remove = await screen.findByRole('button', { name: 'Remove from Finance' })

    fireEvent.click(remove)

    await waitFor(() => expect(mockUnlinkProjectItem).toHaveBeenCalledTimes(1))
    expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
      projectId: 'p2',
      itemType: 'calendar_event',
      itemId: 'evt-1'
    })
  })

  it('switching the primary project leaves the extra link untouched', async () => {
    mockListForItem.mockResolvedValue([
      { id: 'p1', name: 'Launch', color: '#ff0000', icon: null },
      { id: 'p2', name: 'Finance', color: '#00ff00', icon: null }
    ])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )

    fireEvent.click(screen.getByText('pick-Finance'))

    await waitFor(() => expect(mockUnlinkProjectItem).toHaveBeenCalledTimes(1))
    expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
      projectId: 'p1',
      itemType: 'calendar_event',
      itemId: 'evt-1'
    })
  })

  it('keeps the picked project primary when the reload returns the links reordered', async () => {
    // `getProjectsForItem` has no ORDER BY, so row order is insertion order:
    // after unlink(p1) + link(p3) the surviving legacy link (p2) comes back
    // FIRST and the just-picked p3 second. Reading `links[0]` here would show
    // Finance in the picker and demote Marketing — the project the user just
    // chose — to a chip.
    mockListForItem
      .mockResolvedValueOnce([
        { id: 'p1', name: 'Launch', color: '#ff0000', icon: null },
        { id: 'p2', name: 'Finance', color: '#00ff00', icon: null }
      ])
      .mockResolvedValue([
        { id: 'p2', name: 'Finance', color: '#00ff00', icon: null },
        { id: 'p3', name: 'Marketing', color: '#0000ff', icon: null }
      ])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )

    fireEvent.click(screen.getByText('pick-Marketing'))

    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p3')
    )
    // Finance was never picked here, so it stays the chip it already was.
    expect(screen.getByRole('button', { name: 'Remove from Finance' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove from Marketing' })).not.toBeInTheDocument()
  })

  it('shows a link to an archived project as a chip rather than as "No project"', async () => {
    // The picker cannot render an archived project (it filters them out), so
    // the link has to stay visible somewhere — otherwise the row reads "No
    // project" while a link exists, a regression against the read-only chips.
    mockListForItem.mockResolvedValue([{ id: 'p4', name: 'Retired', color: '#999999', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

    expect(await screen.findByRole('button', { name: 'Remove from Retired' })).toBeInTheDocument()
    expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', '')
  })

  it('does not unlink an archived link the picker never showed', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p4', name: 'Retired', color: '#999999', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    // Wait on the load itself, not on how the link ends up rendered, so the
    // click below happens with `links` committed either way.
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(1))
    await act(async () => {})

    fireEvent.click(screen.getByText('pick-Launch'))

    await waitFor(() =>
      expect(mockLinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'evt-1'
      })
    )
    // The archived link was never on screen as a picker value, so the user
    // never chose to replace it. Only an explicit chip × may remove it.
    expect(mockUnlinkProjectItem).not.toHaveBeenCalled()
  })

  it('keeps the write guard closed when a project update reloads mid-swap', async () => {
    // `unlinkItemFromProject` publishes `projectUpdated` BEFORE it resolves,
    // so a reload lands between the unlink and the link of one swap and sees
    // the intermediate (empty) DB state. Sharing one flag between load and
    // write let that reload's `finally` reopen the guard with stale-empty
    // `links`, and the next click would link a third project without
    // unlinking anything.
    mockListForItem
      .mockResolvedValueOnce([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'p2', name: 'Finance', color: '#00ff00', icon: null }])
    let updateHandler: (() => void) | undefined
    mockOnProjectUpdated.mockImplementation((cb: () => void) => {
      updateHandler = cb
      return () => {}
    })
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

    // The broadcast the in-flight unlink itself publishes.
    updateHandler?.()
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(2))
    // That reload has resolved and committed the intermediate empty state.
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', '')
    )

    // A click landing in exactly that window, on a THIRD project so it cannot
    // be absorbed by the "same id, no-op" short-circuit.
    fireEvent.click(screen.getByText('pick-Marketing'))

    resolveUnlink?.({ success: true })
    await waitFor(() =>
      expect(mockLinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p2',
        itemType: 'calendar_event',
        itemId: 'evt-1'
      })
    )
    expect(mockLinkProjectItem).toHaveBeenCalledTimes(1)
    expect(mockLinkProjectItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p3' })
    )
    expect(mockUnlinkProjectItem).toHaveBeenCalledTimes(1)
  })

  it('shows no chips when the event has a single project', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )
    expect(screen.queryByRole('button', { name: /^Remove from/ })).not.toBeInTheDocument()
  })
})
