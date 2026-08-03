import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EventProjectField } from './event-project-field'

const { mockListForItem, mockLinkProjectItem, mockUnlinkProjectItem, mockOnProjectUpdated } =
  vi.hoisted(() => ({
    mockListForItem: vi.fn(),
    mockLinkProjectItem: vi.fn(),
    mockUnlinkProjectItem: vi.fn(),
    mockOnProjectUpdated: vi.fn(() => () => {})
  }))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listForItem: mockListForItem,
    linkProjectItem: mockLinkProjectItem,
    unlinkProjectItem: mockUnlinkProjectItem
  },
  onProjectUpdated: mockOnProjectUpdated
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
