/**
 * Picking a property from the row's `+` menu has to open that property's
 * picker on the first try, and the picker has to stay open while it is used.
 * The real TaskRow and the real Radix menus and popovers run here; only the
 * services and data hooks are stubbed, and animation frames are stepped by
 * hand so the focus hand-offs happen in the order they do in the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { TaskBlockRenderer, type TaskBlock, type TaskBlockEditor } from './task-block-renderer'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  taskState: { task: null as unknown, isLoading: false, isDeleted: false },
  projects: [] as unknown[]
}))

vi.mock('@/contexts/tasks', () => ({ useTasksOptional: () => ({ projects: mocks.projects }) }))
vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: vi.fn() }) }))
vi.mock('@/services/tasks-service', () => ({
  tasksService: { update: mocks.update, complete: vi.fn(), uncomplete: vi.fn(), delete: vi.fn() }
}))
vi.mock('./use-task-block-data', () => ({ useTaskBlockData: () => mocks.taskState }))
vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))
vi.mock('@/hooks/use-notes-query', () => ({ useNoteTagsQuery: () => ({ tags: [] }) }))
vi.mock('@/components/filing/tag-autocomplete', () => ({
  TagAutocomplete: () => <input aria-label="tag search" />
}))

const project = {
  id: 'project-1',
  name: 'Inbox',
  color: '#000',
  isDefault: true,
  statuses: [{ id: 'todo', name: 'Todo', type: 'todo', color: '#aaa', order: 0 }]
}

const task = {
  id: 'task-1',
  title: 'Ship the beta',
  description: null,
  projectId: 'project-1',
  statusId: 'todo',
  priority: 0,
  startDate: null,
  dueDate: null,
  dueTime: null,
  repeatConfig: null,
  linkedNoteIds: [],
  linkedCanvasIds: [],
  tags: [],
  sourceNoteId: null,
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  archivedAt: null
}

const block: TaskBlock = {
  id: 'block-1',
  type: 'taskBlock',
  props: { taskId: 'task-1', title: 'Ship the beta', checked: false, parentTaskId: '' },
  children: []
}

const editor: TaskBlockEditor = {
  document: [block],
  updateBlock: vi.fn(),
  replaceBlocks: vi.fn(),
  removeBlocks: vi.fn(),
  insertBlocks: vi.fn(),
  setTextCursorPosition: vi.fn(),
  focus: vi.fn(),
  getTextCursorPosition: vi.fn(() => ({ block }))
}

let frames: FrameRequestCallback[] = []
const runFrames = (count: number): void => {
  for (let i = 0; i < count; i++) {
    const due = frames
    frames = []
    act(() => due.forEach((callback) => callback(performance.now())))
  }
}

const pickFromAddMenu = async (label: string): Promise<void> => {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Add property' }), { key: 'Enter' })
  const item = await screen.findByRole('menuitem', { name: new RegExp(`^${label}`) })
  fireEvent.click(item)
  runFrames(4)
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  mocks.projects = [project]
  mocks.taskState.task = task
  mocks.update.mockResolvedValue({ success: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('adding a property from the + menu', () => {
  it('opens the due date picker on the first pick', async () => {
    render(<TaskBlockRenderer block={block} editor={editor} />)

    await pickFromAddMenu('Due date')

    expect(screen.getByRole('radio', { name: 'Due' })).toHaveAttribute('aria-checked', 'true')
  })

  it('opens the start date picker on the first pick', async () => {
    render(<TaskBlockRenderer block={block} editor={editor} />)

    await pickFromAddMenu('Start date')

    expect(screen.getByRole('radio', { name: 'Start' })).toHaveAttribute('aria-checked', 'true')
  })

  it('opens the due date picker from D on a selected task', () => {
    render(<TaskBlockRenderer block={block} editor={editor} />)

    const row = screen.getByRole('group', { name: 'Ship the beta' })
    act(() => row.focus())
    fireEvent.keyDown(row, { key: 'd' })
    runFrames(4)

    expect(screen.getByRole('radio', { name: 'Due' })).toHaveAttribute('aria-checked', 'true')
  })

  it('keeps the picker open while the user clicks around inside it', async () => {
    render(<TaskBlockRenderer block={block} editor={editor} />)
    await pickFromAddMenu('Due date')

    // A click on the picker's own surface, not on one of its controls.
    fireEvent.click(screen.getByRole('radiogroup', { name: 'Dates' }))
    runFrames(4)

    expect(screen.getByRole('radio', { name: 'Due' })).toBeInTheDocument()
  })
})
