import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProjectSelector } from './project-selector'
import { useTasksOptional } from '@/contexts/tasks'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: vi.fn(),
  useTasksContext: vi.fn()
}))

const statuses = [
  { id: 'todo', name: 'Todo', color: '#000', type: 'todo' as const, order: 0 },
  { id: 'done', name: 'Done', color: '#000', type: 'done' as const, order: 1 }
]

const projects: Project[] = [
  {
    id: 'work',
    name: 'Work',
    description: '',
    icon: 'briefcase',
    color: '#EF4444',
    statuses,
    isDefault: false,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 1
  },
  {
    id: 'home',
    name: 'Home',
    description: '',
    icon: 'home',
    color: '#10B981',
    statuses,
    isDefault: false,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 0
  },
  {
    id: 'old',
    name: 'Old',
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

const tasks = [
  { id: 't1', projectId: 'work', statusId: 'todo', parentId: null }
] as unknown as Task[]

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

describe('ProjectSelector', () => {
  const onProjectSelect = vi.fn()
  const onProjectEdit = vi.fn()
  const onProjectArchive = vi.fn()
  const onProjectDelete = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject: vi.fn() } as never)
  })

  const renderSelector = (selectedProjectId: string | null = 'work') =>
    renderWithI18n(
      <ProjectSelector
        tasks={tasks}
        projects={projects}
        selectedProjectId={selectedProjectId}
        onProjectSelect={onProjectSelect}
        onProjectEdit={onProjectEdit}
        onProjectArchive={onProjectArchive}
        onProjectDelete={onProjectDelete}
      />
    )

  it('lists active projects with incomplete counts and a create footer; excludes archived', async () => {
    const user = userEvent.setup()
    renderSelector()

    await user.click(screen.getByRole('combobox'))

    expect(screen.getByRole('option', { name: /work/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /home/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /old/i })).not.toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument()
  })

  it('calls onProjectSelect when a different project is chosen', async () => {
    const user = userEvent.setup()
    renderSelector('work')

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: /home/i }))

    expect(onProjectSelect).toHaveBeenCalledWith('home')
  })

  it('edits the selected project via the trailing pencil button', async () => {
    const user = userEvent.setup()
    renderSelector('work')

    // Picker closed → the only plain button is the pencil edit affordance.
    await user.click(screen.getByRole('button'))

    expect(onProjectEdit).toHaveBeenCalledWith(projects[0])
  })

  it('runs per-row edit action from the actions menu', async () => {
    const user = userEvent.setup()
    renderSelector('home')

    await user.click(screen.getByRole('combobox'))
    const workOption = screen.getByRole('option', { name: /work/i })
    await user.click(within(workOption).getByRole('button'))
    await user.click(screen.getByRole('menuitem', { name: 'Edit project' }))

    expect(onProjectEdit).toHaveBeenCalledWith(projects[0])
  })
})
