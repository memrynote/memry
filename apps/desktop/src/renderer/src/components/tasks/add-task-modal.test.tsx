import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement, ReactNode } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'
import { AddTaskModal } from './add-task-modal'
import type { Project, Status } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

// BlockNote can't mount in jsdom; stub the description editor with a textarea.
vi.mock('./task-description-editor', () => ({
  TaskDescriptionEditor: ({
    initialContent,
    onContentChange,
    placeholder
  }: {
    initialContent: string | null
    onContentChange?: (markdown: string) => void
    placeholder?: string
  }) => (
    <textarea
      placeholder={placeholder}
      defaultValue={initialContent ?? ''}
      onChange={(event) => onContentChange?.(event.target.value)}
    />
  )
}))

// TagAutocomplete fetches its own tag data (useAllTags/useTags: react-query +
// window.api). The modal only cares that it wires tags/onTagsChange through
// to the created task, so stub it here — its own behavior is covered by
// tag-autocomplete.test.tsx.
vi.mock('@/components/filing/tag-autocomplete', () => ({
  TagAutocomplete: ({
    tags,
    onTagsChange,
    placeholder
  }: {
    tags: string[]
    onTagsChange: (tags: string[]) => void
    placeholder?: string
  }) => (
    <div>
      <span data-testid="tag-autocomplete-tags">{tags.join(',')}</span>
      <button type="button" onClick={() => onTagsChange([...tags, 'urgent'])}>
        {placeholder}
      </button>
    </div>
  )
}))

let i18nEn: I18nInstance
let i18nTr: I18nInstance

function renderWithI18n(ui: ReactElement, i18n = i18nEn) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
  )
  return render(ui, { wrapper: Wrapper })
}

beforeAll(async () => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  i18nEn = await createRendererI18n({ locale: 'en' })
  i18nTr = await createRendererI18n({ locale: 'tr' })
})

const P_TODO: Status = { id: 'p-todo', name: 'To Do', color: '#666', type: 'todo', order: 0 }
const P_PROGRESS: Status = {
  id: 'p-prog',
  name: 'In Progress',
  color: '#00f',
  type: 'in_progress',
  order: 1
}
const P_DONE: Status = { id: 'p-done', name: 'Done', color: '#0f0', type: 'done', order: 2 }

const W_TODO: Status = { id: 'w-todo', name: 'Backlog', color: '#666', type: 'todo', order: 0 }
const W_PROGRESS: Status = {
  id: 'w-prog',
  name: 'Working',
  color: '#00f',
  type: 'in_progress',
  order: 1
}
const W_DONE: Status = { id: 'w-done', name: 'Shipped', color: '#0f0', type: 'done', order: 2 }

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'personal',
    name: 'Personal',
    description: '',
    icon: 'User',
    color: '#6366f1',
    statuses: [P_TODO, P_PROGRESS, P_DONE],
    isDefault: true,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 0,
    ...overrides
  }
}

const PERSONAL = makeProject()
const WORK = makeProject({
  id: 'work',
  name: 'Work',
  color: '#ef4444',
  isDefault: false,
  statuses: [W_TODO, W_PROGRESS, W_DONE]
})
const PROJECTS = [PERSONAL, WORK]

describe('AddTaskModal', () => {
  let onClose: ReturnType<typeof vi.fn>
  let onAddTask: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    onAddTask = vi.fn()
  })

  describe('default project from settings', () => {
    it('submits task with the provided defaultProjectId', async () => {
      // #given — settings set default project to "work"
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )

      // #when — type a title and submit
      const titleInput = screen.getByPlaceholderText('What needs to be done?')
      await user.type(titleInput, 'Test task from settings')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — task should be created in the Work project
      expect(onAddTask).toHaveBeenCalledOnce()
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.projectId).toBe('work')
      expect(createdTask.title).toBe('Test task from settings')
    })

    it('uses work project default todo status when defaultProjectId is work', async () => {
      // #given
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )

      // #when
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Status check')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — should use Work project's todo status (Backlog), not Personal's
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.statusId).toBe('w-todo')
    })

    it('falls back to personal when defaultProjectId is omitted', async () => {
      // #given — no defaultProjectId passed (defaults to 'personal')
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )

      // #when
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Fallback test')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.projectId).toBe('personal')
      expect(createdTask.statusId).toBe('p-todo')
    })

    it('handles non-existent defaultProjectId gracefully', async () => {
      // #given — settings point to a deleted project
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="deleted-project"
        />
      )

      // #when
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Ghost project')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — should still submit (projectId = deleted-project, empty statusId)
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.projectId).toBe('deleted-project')
      expect(createdTask.statusId).toBe('')
    })

    it('resets to defaultProjectId when modal reopens', async () => {
      // #given — submit once, close, then reopen
      const user = userEvent.setup()
      const { rerender } = renderWithI18n(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )

      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'First task')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // Reopen the modal
      rerender(
        <AddTaskModal
          isOpen={false}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )
      rerender(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )

      // #when — submit again
      await waitFor(() => {
        expect(screen.getByPlaceholderText('What needs to be done?')).toBeInTheDocument()
      })
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Second task')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — should still use work project
      const secondTask: Task = onAddTask.mock.calls[1][0]
      expect(secondTask.projectId).toBe('work')
    })
  })

  describe('form validation', () => {
    it('shows error when submitting without title', async () => {
      // #given
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )

      // #when — submit without entering title
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then
      expect(screen.getByText('Title is required')).toBeInTheDocument()
      expect(onAddTask).not.toHaveBeenCalled()
    })

    it('renders Turkish task strings for Turkish', () => {
      renderWithI18n(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />,
        i18nTr
      )

      expect(screen.getAllByText('Görev Ekle').length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('tags', () => {
    it('includes tags added via TagAutocomplete on the created task', async () => {
      // #given
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )

      // #when — type a title, add a tag via the stubbed TagAutocomplete, submit
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Tagged task')
      await user.click(screen.getByRole('button', { name: 'Tags' }))
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — the created task carries the tag entered in the modal
      expect(onAddTask).toHaveBeenCalledOnce()
      const createdTask: Task = onAddTask.mock.calls[0][0]
      expect(createdTask.tags).toEqual(['urgent'])
    })

    it('resets tags when "create another" submits and clears the form', async () => {
      // #given — create another is checked
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )
      await user.click(screen.getByRole('checkbox', { name: 'Create another' }))

      // #when — first task gets a tag and is submitted
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'First tagged task')
      await user.click(screen.getByRole('button', { name: 'Tags' }))
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — the form's tag state clears for the next task
      expect(screen.getByTestId('tag-autocomplete-tags')).toHaveTextContent('')
    })
  })

  describe('modern layout', () => {
    it('renders the four property rows with default badge values', () => {
      // #given / #when — open with the default personal project
      renderWithI18n(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )

      // #then — each Interactive*Badge shows its default value (badges render as
      // triggers; their popovers don't open in jsdom, so only the trigger text is present)
      expect(screen.getByText('To Do')).toBeInTheDocument() // status = default todo
      expect(screen.getByText('None')).toBeInTheDocument() // priority compact label
      expect(screen.getByText('No date')).toBeInTheDocument() // due date badge, no date
      expect(screen.getByText('Personal')).toBeInTheDocument() // project badge
    })

    it('renders the description editor section', () => {
      // #given / #when
      renderWithI18n(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )

      // #then — stubbed TaskDescriptionEditor exposes the placeholder
      expect(screen.getByPlaceholderText('Add a description…')).toBeInTheDocument()
    })
  })

  describe('submit behavior', () => {
    it('submits via Cmd/Ctrl+Enter', async () => {
      // #given
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
      )

      // #when — type a title, then press Meta+Enter (bubbles to the dialog's onKeyDown)
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Keyboard submit')
      await user.keyboard('{Meta>}{Enter}{/Meta}')

      // #then
      expect(onAddTask).toHaveBeenCalledOnce()
      expect(onAddTask.mock.calls[0][0].title).toBe('Keyboard submit')
    })

    it('keeps project/status/due and clears title on "create another"', async () => {
      // #given — create another checked, work project
      const user = userEvent.setup()
      renderWithI18n(
        <AddTaskModal
          isOpen={true}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={PROJECTS}
          defaultProjectId="work"
        />
      )
      await user.click(screen.getByRole('checkbox', { name: 'Create another' }))

      // #when — submit the first task
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'First')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — modal stays open and the title clears
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByPlaceholderText('What needs to be done?')).toHaveValue('')

      // #when — submit a second task
      await user.type(screen.getByPlaceholderText('What needs to be done?'), 'Second')
      await user.click(screen.getByRole('button', { name: 'Add Task' }))

      // #then — project/status/due are retained from the first submission
      const first: Task = onAddTask.mock.calls[0][0]
      const second: Task = onAddTask.mock.calls[1][0]
      expect(second.projectId).toBe(first.projectId)
      expect(second.statusId).toBe(first.statusId)
      expect(second.dueDate).toEqual(first.dueDate)
    })
  })
})
