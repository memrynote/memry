import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { InteractiveProjectBadge } from './interactive-project-badge'
import type { Project } from '@/data/tasks-data'
import { useTasksOptional } from '@/contexts/tasks'

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: vi.fn(),
  useTasksContext: vi.fn()
}))

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

function renderWithI18n(ui: ReactElement) {
  return render(
    <TooltipProvider>
      <I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>
    </TooltipProvider>
  )
}

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

describe('InteractiveProjectBadge create-project footer', () => {
  const onProjectChange = vi.fn()
  const addProject = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject } as never)
  })

  it('does not show the footer without allowCreate', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))

    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  })

  it('shows the footer and opens the dialog when allowCreate is set', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
        allowCreate
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(screen.getByRole('heading', { name: 'Create Project' })).toBeInTheDocument()
  })

  it('creates the project and selects it when allowCreate is set', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
        allowCreate
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))
    await user.click(screen.getByRole('button', { name: 'Create project' }))
    await user.type(screen.getAllByRole('textbox')[0], 'Roadmap')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(addProject).toHaveBeenCalledTimes(1))
    const created = addProject.mock.calls[0][0] as Project
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith(created.id))
  })
})
