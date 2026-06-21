import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TasksWidget } from './tasks-widget'

const tasks = [
  { id: 't1', title: 'Alpha' },
  { id: 't2', title: 'Beta' },
  { id: 't3', title: 'Gamma' },
  { id: 't4', title: 'Delta' }
]

let mockTasks = tasks

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({
    tasks: mockTasks,
    projects: [],
    isLoading: false
  })
}))

vi.mock('@/lib/task-utils/task-view-helpers', () => ({
  getFilteredTasks: (input: typeof tasks) => input
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

describe('TasksWidget', () => {
  beforeEach(() => {
    mockTasks = tasks
  })

  it('lists tasks', () => {
    render(<TasksWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('respects the size limit', () => {
    render(<TasksWidget config={{}} size="S" />)
    expect(screen.getAllByTestId('task-item')).toHaveLength(3)
  })

  it('renders an empty state when there are no tasks', () => {
    mockTasks = []
    render(<TasksWidget config={{}} size="M" />)
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument()
  })
})
