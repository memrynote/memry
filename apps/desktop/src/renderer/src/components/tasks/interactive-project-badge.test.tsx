import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InteractiveProjectBadge } from './interactive-project-badge'
import type { Project } from '@/data/tasks-data'

const projects: Project[] = [
  {
    id: 'proj-1',
    name: 'Personal',
    description: '',
    icon: 'inbox',
    color: '#6366F1',
    statuses: [],
    isDefault: true,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 5
  },
  {
    id: 'proj-2',
    name: 'Work',
    description: '',
    icon: 'briefcase',
    color: '#EF4444',
    statuses: [],
    isDefault: false,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 3
  },
  {
    id: 'proj-archived',
    name: 'Old Project',
    description: '',
    icon: 'archive',
    color: '#999999',
    statuses: [],
    isDefault: false,
    isArchived: true,
    createdAt: new Date(),
    taskCount: 0
  }
]

describe('InteractiveProjectBadge', () => {
  const onProjectChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders trigger button with current project name and color', () => {
    render(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    const btn = screen.getByRole('button', { name: /project:.*click to change/i })
    expect(btn).toBeInTheDocument()
    expect(screen.getByText('Personal')).toBeInTheDocument()
  })

  it('shows fallback when projectId does not match any project', () => {
    render(
      <InteractiveProjectBadge
        projectId="nonexistent"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    const btn = screen.getByRole('button', { name: /project:.*click to change/i })
    expect(btn).toBeInTheDocument()
  })

  it('opens popover with available projects on click', async () => {
    const user = userEvent.setup()
    render(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))

    const options = screen.getAllByRole('option')
    const optionLabels = options.map((opt) => opt.textContent)
    expect(optionLabels).toContain('Personal')
    expect(optionLabels).toContain('Work')
  })

  it('excludes archived projects from the dropdown', async () => {
    const user = userEvent.setup()
    render(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))

    expect(screen.queryByText('Old Project')).not.toBeInTheDocument()
  })

  it('calls onProjectChange with new projectId when selected', async () => {
    const user = userEvent.setup()
    render(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))
    await user.click(screen.getByText('Work'))

    expect(onProjectChange).toHaveBeenCalledWith('proj-2')
  })

  it('highlights currently selected project with aria-selected', async () => {
    const user = userEvent.setup()
    render(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))

    const options = screen.getAllByRole('option')
    const personalOption = options.find((opt) => opt.textContent?.includes('Personal'))
    expect(personalOption).toBeDefined()
    expect(personalOption).toHaveAttribute('aria-selected', 'true')
  })

  it('does not call onProjectChange when selecting the same project', async () => {
    const user = userEvent.setup()
    render(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))

    const options = screen.getAllByRole('option')
    const personalOption = options.find((opt) => opt.textContent?.includes('Personal'))!
    await user.click(personalOption)

    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('stops propagation on trigger click', async () => {
    const parentClick = vi.fn()
    const user = userEvent.setup()

    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={parentClick}>
        <InteractiveProjectBadge
          projectId="proj-1"
          projects={projects}
          onProjectChange={onProjectChange}
        />
      </div>
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))

    expect(parentClick).not.toHaveBeenCalled()
  })
})
