import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProjectPicker } from './project-picker'
import { useTasksOptional } from '@/contexts/tasks'
import type { Project } from '@/data/tasks-data'

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: vi.fn(),
  useTasksContext: vi.fn()
}))

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

describe('ProjectPicker — button variant', () => {
  const onChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject: vi.fn() } as never)
  })

  it('lists active projects and excludes archived', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectPicker value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))

    const labels = screen.getAllByRole('option').map((o) => o.textContent)
    expect(labels).toContain('Personal')
    expect(labels).toContain('Work')
    expect(screen.queryByText('Old Project')).not.toBeInTheDocument()
  })

  it('calls onChange with the selected project id', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectPicker value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByText('Work'))

    expect(onChange).toHaveBeenCalledWith('proj-2')
  })

  it('marks the current project aria-selected and does not fire on reselect', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectPicker value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))
    const personal = screen.getAllByRole('option').find((o) => o.textContent?.includes('Personal'))!
    expect(personal).toHaveAttribute('aria-selected', 'true')

    await user.click(personal)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('ProjectPicker — create footer', () => {
  const onChange = vi.fn()
  const addProject = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject } as never)
  })

  it('shows the footer when inside tasks context (default allowCreate)', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectPicker value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))
    expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument()
  })

  it('hides the footer without tasks context', async () => {
    vi.mocked(useTasksOptional).mockReturnValue(null)
    const user = userEvent.setup()
    renderWithI18n(<ProjectPicker value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  })

  it('hides the footer when allowCreate is false', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <ProjectPicker value="proj-1" onChange={onChange} projects={projects} allowCreate={false} />
    )

    await user.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  })

  it('creates a project from the footer and auto-selects it', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectPicker value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('button', { name: 'Create project' }))
    expect(screen.getByRole('heading', { name: 'Create Project' })).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Project name'), 'Roadmap')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(addProject).toHaveBeenCalledTimes(1))
    const created = addProject.mock.calls[0][0] as Project
    expect(created.name).toBe('Roadmap')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(created.id))
  })
})

describe('ProjectPicker — badge variant', () => {
  const onChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject: vi.fn() } as never)
  })

  it('renders a badge trigger with the project name and stops propagation', async () => {
    const parentClick = vi.fn()
    const user = userEvent.setup()
    renderWithI18n(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={parentClick}>
        <ProjectPicker
          value="proj-1"
          onChange={onChange}
          projects={projects}
          triggerVariant="badge"
        />
      </div>
    )

    const trigger = screen.getByRole('button', { name: /project:.*click to change/i })
    expect(screen.getByText('Personal')).toBeInTheDocument()
    await user.click(trigger)
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('hides the create footer by default in badge variant unless allowCreate', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <ProjectPicker
        value="proj-1"
        onChange={onChange}
        projects={projects}
        triggerVariant="badge"
        allowCreate={false}
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  })
})

describe('ProjectPicker — all option, search, counts, actions', () => {
  const onChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject: vi.fn() } as never)
  })

  it('renders the All projects option and maps it to null on change', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <ProjectPicker value="proj-1" onChange={onChange} projects={projects} includeAllOption />
    )

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByText('All projects'))

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('marks the All option selected when value is null', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <ProjectPicker value={null} onChange={onChange} projects={projects} includeAllOption />
    )

    await user.click(screen.getByRole('combobox'))
    const allOption = screen
      .getAllByRole('option')
      .find((o) => o.textContent?.includes('All projects'))!
    expect(allOption).toHaveAttribute('aria-selected', 'true')
  })

  it('filters the list with the search box', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <ProjectPicker value="proj-1" onChange={onChange} projects={projects} searchable />
    )

    await user.click(screen.getByRole('combobox'))
    await user.type(screen.getByRole('textbox'), 'work')

    const labels = screen.getAllByRole('option').map((o) => o.textContent)
    expect(labels.some((l) => l?.includes('Work'))).toBe(true)
    expect(labels.some((l) => l?.includes('Personal'))).toBe(false)
  })

  it('shows per-project counts and a per-row actions slot', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <ProjectPicker
        value="proj-1"
        onChange={onChange}
        projects={projects}
        showCounts
        taskCountByProject={{ 'proj-1': 7, 'proj-2': 0 }}
        renderItemActions={(p) => <span data-testid={`actions-${p.id}`}>•</span>}
      />
    )

    await user.click(screen.getByRole('combobox'))
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByTestId('actions-proj-1')).toBeInTheDocument()
    expect(screen.getByTestId('actions-proj-2')).toBeInTheDocument()
  })
})
