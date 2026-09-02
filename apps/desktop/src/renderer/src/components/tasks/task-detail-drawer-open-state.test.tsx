/**
 * The drawer's open/closed contract, which the E2E specs address it by.
 *
 * Before #1931 the closed drawer stayed mounted behind `inert`, `aria-hidden`
 * and `width: 0`. A 1px border still gave it a box, so Playwright reported it
 * visible in both states and every `state: 'visible'` / `state: 'hidden'` wait
 * on it passed without proving anything. jsdom computes no layout, so these
 * tests assert the thing Playwright's visibility check was standing in for:
 * whether the element the specs select is in the document at all, and whether
 * it names itself open.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement, ReactNode } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'
import { TaskDetailDrawer, type TaskDetailDrawerProps } from './task-detail-drawer'
import type { Task } from '@/data/task-model'
import type { Project, Status } from '@/data/tasks-data'

vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: vi.fn().mockResolvedValue(null),
    getFile: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ notes: [] })
  }
}))

// Pulls in the whole tag-sync chain (use-all-tags -> window.api listeners),
// none of which the open/closed contract depends on.
vi.mock('@/components/filing/tag-autocomplete', () => ({
  TagAutocomplete: () => null
}))

vi.mock('@/services/canvas-service', () => ({
  canvasService: { list: vi.fn().mockResolvedValue({ canvases: [] }) }
}))

vi.mock('@/services/search-service', () => ({
  searchService: {
    query: vi.fn().mockResolvedValue({ groups: [], totalCount: 0, queryTimeMs: 0 })
  }
}))

const statuses: Status[] = [
  { id: 'todo', name: 'To Do', color: '#6B7280', type: 'todo', order: 0 },
  { id: 'done', name: 'Done', color: '#10B981', type: 'done', order: 1 }
]

const project: Project = {
  id: 'project-1',
  name: 'Test Project',
  description: '',
  icon: 'Folder',
  color: '#6366F1',
  statuses,
  isDefault: false,
  isArchived: false,
  createdAt: new Date('2026-01-01'),
  taskCount: 1
}

const task: Task = {
  id: 'task-1',
  title: 'Test Task',
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'medium',
  dueDate: new Date('2026-04-15'),
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-01-01'),
  completedAt: null,
  archivedAt: null
}

const props: TaskDetailDrawerProps = {
  task,
  isOpen: true,
  onClose: vi.fn(),
  tasks: [task],
  projects: [project]
}

let i18nEn: I18nInstance

function renderWithI18n(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18nEn}>{children}</I18nextProvider>
    </QueryClientProvider>
  )
  return render(ui, { wrapper: Wrapper })
}

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

/** What `openTaskDrawer` in tests/e2e/utils/task-drawer-helpers.ts selects. */
const OPEN_DRAWER = 'aside[aria-label="Task details"][data-state="open"]'

describe('TaskDetailDrawer — open state', () => {
  it('names itself open, so the E2E locator matches exactly one element', () => {
    const { container } = renderWithI18n(<TaskDetailDrawer {...props} />)

    expect(container.querySelectorAll(OPEN_DRAWER)).toHaveLength(1)
    expect(screen.getByRole('complementary', { name: 'Task details' })).toHaveAttribute(
      'data-state',
      'open'
    )
  })

  it('leaves the DOM entirely when closed', () => {
    const { container } = renderWithI18n(<TaskDetailDrawer {...props} isOpen={false} />)

    expect(container.querySelectorAll(OPEN_DRAWER)).toHaveLength(0)
    expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull()
    expect(container.querySelector('aside')).toBeNull()
  })

  it('does not leave a closed drawer behind when it reopens on another task', () => {
    const other: Task = { ...task, id: 'task-2', title: 'Other Task' }
    const { container, rerender } = renderWithI18n(<TaskDetailDrawer {...props} />)

    rerender(<TaskDetailDrawer {...props} isOpen={false} />)
    expect(container.querySelectorAll(OPEN_DRAWER)).toHaveLength(0)

    rerender(<TaskDetailDrawer {...props} task={other} />)
    expect(container.querySelectorAll(OPEN_DRAWER)).toHaveLength(1)
  })
})
