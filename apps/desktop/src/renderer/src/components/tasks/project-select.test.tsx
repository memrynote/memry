import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProjectSelect } from './project-select'
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
    taskCount: 0
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

describe('ProjectSelect create-project footer', () => {
  const onChange = vi.fn()
  const addProject = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject } as never)
  })

  it('shows the "Create project" footer when tasks context is available', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectSelect value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))

    expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument()
  })

  it('hides the footer when there is no tasks context', async () => {
    vi.mocked(useTasksOptional).mockReturnValue(null)
    const user = userEvent.setup()
    renderWithI18n(<ProjectSelect value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))

    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  })

  it('opens the Create Project dialog when the footer is clicked', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectSelect value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(screen.getByRole('heading', { name: 'Create Project' })).toBeInTheDocument()
  })

  it('creates the project and auto-selects it', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectSelect value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    await user.type(screen.getAllByRole('textbox')[0], 'Roadmap')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(addProject).toHaveBeenCalledTimes(1))
    const created = addProject.mock.calls[0][0] as Project
    expect(created.name).toBe('Roadmap')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(created.id))
  })
})
