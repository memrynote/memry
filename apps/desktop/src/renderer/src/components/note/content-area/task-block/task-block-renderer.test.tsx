import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { TaskBlockRenderer, type TaskBlock, type TaskBlockEditor } from './task-block-renderer'
import type React from 'react'

const mocks = vi.hoisted(() => ({
  taskState: {
    task: null as any,
    isLoading: false,
    isDeleted: false
  },
  projects: [] as any[],
  openTab: vi.fn(),
  update: vi.fn(),
  complete: vi.fn(),
  uncomplete: vi.fn(),
  deleteTask: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({ projects: mocks.projects })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    update: mocks.update,
    complete: mocks.complete,
    uncomplete: mocks.uncomplete,
    delete: mocks.deleteTask
  }
}))

vi.mock('./use-task-block-data', () => ({
  useTaskBlockData: () => mocks.taskState
}))

vi.mock('@/components/tasks/task-row', () => ({
  TaskRow: ({
    task,
    project,
    isCompleted,
    onToggleComplete,
    onUpdateTask,
    onProjectChange,
    actions,
    renderTitle
  }: {
    task: { id: string; title: string }
    project: { id: string; name: string }
    isCompleted: boolean
    onToggleComplete: (taskId: string) => void
    onUpdateTask: (taskId: string, updates: Record<string, unknown>) => void
    onProjectChange: (projectId: string) => void
    actions: React.ReactNode
    renderTitle: () => React.ReactNode
  }) => (
    <div data-testid="task-row" data-task-id={task.id} data-project-id={project.id}>
      <span>{isCompleted ? 'done' : 'open'}</span>
      {renderTitle()}
      {actions}
      <button type="button" onClick={() => onToggleComplete(task.id)}>
        toggle
      </button>
      <button type="button" onClick={() => onUpdateTask(task.id, { priority: 'urgent' })}>
        priority
      </button>
      <button type="button" onClick={() => onUpdateTask(task.id, { statusId: 'done' })}>
        status
      </button>
      <button type="button" onClick={() => onProjectChange('project-2')}>
        project
      </button>
    </div>
  )
}))

function makeBlock(overrides: Partial<TaskBlock['props']> = {}): TaskBlock {
  return {
    id: 'block-1',
    type: 'taskBlock',
    props: {
      taskId: 'task-1',
      title: 'Draft task',
      checked: false,
      parentTaskId: '',
      ...overrides
    },
    children: []
  }
}

function makeEditor(document: TaskBlock[] = [makeBlock()]): TaskBlockEditor {
  return {
    document,
    updateBlock: vi.fn(),
    replaceBlocks: vi.fn((blocksToRemove: TaskBlock[], blocksToInsert: TaskBlock[]) => {
      const ids = new Set(blocksToRemove.map((block) => block.id))
      const firstIndex = document.findIndex((block) => ids.has(block.id))
      document.splice(firstIndex >= 0 ? firstIndex : 0, blocksToRemove.length, ...blocksToInsert)
    }),
    removeBlocks: vi.fn((blocks: TaskBlock[]) => {
      const ids = new Set(blocks.map((block) => block.id))
      for (let index = document.length - 1; index >= 0; index--) {
        if (ids.has(document[index].id)) document.splice(index, 1)
      }
    }),
    insertBlocks: vi.fn((blocks, referenceBlock, placement) => {
      const index = Math.max(
        0,
        document.findIndex((block) => block.id === referenceBlock.id)
      )
      const inserted = blocks.map((block, offset) => ({
        id: `inserted-${offset}`,
        type: block.type,
        props: {
          taskId: block.props?.taskId ?? '',
          title: block.props?.title ?? '',
          checked: block.props?.checked ?? false,
          parentTaskId: block.props?.parentTaskId ?? ''
        },
        children: []
      }))
      document.splice(placement === 'after' ? index + 1 : index, 0, ...inserted)
    }),
    setTextCursorPosition: vi.fn(),
    focus: vi.fn(),
    getTextCursorPosition: vi.fn(() => ({ block: document[0] }))
  }
}

const project = {
  id: 'project-1',
  name: 'Inbox',
  color: '#000',
  isDefault: true,
  statuses: [
    { id: 'todo', name: 'Todo', type: 'todo', color: '#aaa', order: 0 },
    { id: 'done', name: 'Done', type: 'done', color: '#0a0', order: 1 }
  ]
}

const task = {
  id: 'task-1',
  title: 'Loaded task',
  description: null,
  projectId: 'project-1',
  statusId: 'todo',
  priority: 2,
  dueDate: null,
  dueTime: null,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  archivedAt: null
}

describe('TaskBlockRenderer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.projects = [project]
    mocks.taskState.task = task
    mocks.taskState.isDeleted = false
    mocks.taskState.isLoading = false
    mocks.update.mockResolvedValue({ success: true })
    mocks.complete.mockResolvedValue({ success: true })
    mocks.uncomplete.mockResolvedValue({ success: true })
    mocks.deleteTask.mockResolvedValue({ success: true })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('renders loading and deleted states', () => {
    mocks.projects = []
    mocks.taskState.task = null

    const editor = makeEditor()
    const block = makeBlock()
    const { rerender } = render(
      <TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />
    )

    expect(
      screen.getByText('phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.loading')
    ).toBeInTheDocument()

    mocks.projects = [project]
    mocks.taskState.task = { ...task, title: 'Removed task' }
    mocks.taskState.isDeleted = true
    rerender(<TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />)

    expect(screen.getByText('Removed task')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(editor.removeBlocks).toHaveBeenCalledWith([block])
  })

  it('forwards row actions to services and opens the task tab', async () => {
    const editor = makeEditor()
    const block = makeBlock()
    render(<TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />)

    fireEvent.click(screen.getByText('toggle'))
    await act(async () => Promise.resolve())
    expect(editor.updateBlock).toHaveBeenCalledWith(block, {
      props: { ...block.props, checked: true }
    })
    expect(mocks.complete).toHaveBeenCalledWith({ id: 'task-1' })

    fireEvent.click(screen.getByText('priority'))
    fireEvent.click(screen.getByText('status'))
    fireEvent.click(screen.getByText('project'))
    await act(async () => Promise.resolve())

    expect(mocks.update).toHaveBeenCalledWith({ id: 'task-1', priority: 4 })
    expect(mocks.update).toHaveBeenCalledWith({ id: 'task-1', statusId: 'done' })
    expect(mocks.update).toHaveBeenCalledWith({ id: 'task-1', projectId: 'project-2' })

    fireEvent.click(
      screen.getByTitle(
        'phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.openInTaskPanel'
      )
    )
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: expect.objectContaining({ openTaskId: 'task-1', selectedProjectId: 'project-1' })
      })
    )
  })

  it('edits titles, creates a following task block, and removes empty drafts', async () => {
    const editor = makeEditor()
    const block = makeBlock()
    const { unmount } = render(
      <TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />
    )

    fireEvent.click(screen.getByText('Loaded task'))
    const titleInput = screen.getByDisplayValue('Draft task')
    fireEvent.change(titleInput, { target: { value: 'Renamed task' } })
    act(() => vi.advanceTimersByTime(600))
    await act(async () => Promise.resolve())
    expect(mocks.update).toHaveBeenCalledWith({ id: 'task-1', title: 'Renamed task' })

    fireEvent.keyDown(titleInput, { key: 'Enter' })
    expect(editor.insertBlocks).toHaveBeenCalledWith(
      [{ type: 'taskBlock', props: { taskId: '', title: '', checked: false } }],
      block,
      'after'
    )

    const emptyBlock = makeBlock({ taskId: '', title: '' })
    mocks.taskState.task = null
    unmount()
    render(<TaskBlockRenderer block={emptyBlock} editor={editor} contentRef={vi.fn()} />)

    const emptyInput = screen.getByDisplayValue('')
    fireEvent.keyDown(emptyInput, { key: 'Backspace' })
    expect(editor.removeBlocks).toHaveBeenCalledWith([emptyBlock])
  })

  it('indents and promotes task blocks from the title input', () => {
    const parent = makeBlock({ taskId: 'parent', title: 'Parent' })
    const child = makeBlock({ taskId: 'child', title: 'Child' })
    child.id = 'child-block'
    const editor = makeEditor([parent, child])

    const { rerender } = render(
      <TaskBlockRenderer block={child} editor={editor} contentRef={vi.fn()} />
    )

    fireEvent.click(screen.getByText('Loaded task'))
    fireEvent.keyDown(screen.getByDisplayValue('Child'), { key: 'Tab' })
    expect(editor.replaceBlocks).toHaveBeenCalledWith(
      [parent, child],
      [
        expect.objectContaining({
          children: [
            expect.objectContaining({ props: expect.objectContaining({ parentTaskId: 'parent' }) })
          ]
        })
      ]
    )
    expect(mocks.update).toHaveBeenCalledWith({ id: 'child', parentId: 'parent' })

    const nestedChild = { ...child, props: { ...child.props, parentTaskId: 'parent' } }
    const nestedParent = { ...parent, children: [nestedChild] }
    const nestedEditor = makeEditor([nestedParent])

    rerender(<TaskBlockRenderer block={nestedChild} editor={nestedEditor} contentRef={vi.fn()} />)
    fireEvent.click(screen.getByText('Loaded task'))
    fireEvent.keyDown(screen.getByDisplayValue('Child'), { key: 'Tab', shiftKey: true })

    expect(nestedEditor.replaceBlocks).toHaveBeenCalledWith(
      [nestedParent],
      [
        expect.objectContaining({ children: [] }),
        expect.objectContaining({ props: expect.objectContaining({ parentTaskId: '' }) })
      ]
    )
    expect(mocks.update).toHaveBeenCalledWith({ id: 'child', parentId: null })
  })

  it('syncs loaded service data back into block props', async () => {
    const editor = makeEditor()
    const block = makeBlock({ title: 'Stale title', checked: false })
    mocks.taskState.task = {
      ...task,
      title: 'Fresh DB title',
      completedAt: '2026-01-02T00:00:00.000Z'
    }

    render(<TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />)
    await act(async () => Promise.resolve())

    expect(editor.updateBlock).toHaveBeenCalledWith(block, {
      props: { ...block.props, title: 'Fresh DB title', checked: true }
    })
  })

  it('persists a draft title when the backing task appears', async () => {
    const editor = makeEditor()
    const block = makeBlock({ taskId: '', title: 'Draft title' })
    mocks.taskState.task = null

    const { rerender } = render(
      <TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />
    )
    expect(screen.getByDisplayValue('Draft title')).toBeInTheDocument()

    mocks.taskState.task = { ...task, title: 'Server title' }
    rerender(<TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />)
    await act(async () => Promise.resolve())

    expect(mocks.update).toHaveBeenCalledWith({ id: '', title: 'Draft title' })
    expect(editor.updateBlock).toHaveBeenCalledWith(block, {
      props: { ...block.props, title: 'Draft title' }
    })
  })

  it('saves on Escape, skips the trailing blur, and uncompletes completed tasks', async () => {
    const editor = makeEditor()
    const block = makeBlock({ checked: true })
    mocks.taskState.task = {
      ...task,
      title: 'Loaded task',
      completedAt: '2026-01-02T00:00:00.000Z'
    }

    render(<TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />)

    fireEvent.click(screen.getByText('Loaded task'))
    const titleInput = screen.getByDisplayValue('Draft task')
    fireEvent.change(titleInput, { target: { value: 'Escape saved' } })
    fireEvent.keyDown(titleInput, { key: 'Escape' })
    fireEvent.blur(titleInput)
    await act(async () => Promise.resolve())

    expect(mocks.update).toHaveBeenCalledWith({ id: 'task-1', title: 'Escape saved' })

    fireEvent.click(screen.getByText('toggle'))
    await act(async () => Promise.resolve())

    expect(editor.updateBlock).toHaveBeenLastCalledWith(block, {
      props: { ...block.props, checked: false }
    })
    expect(mocks.uncomplete).toHaveBeenCalledWith('task-1')
  })

  it('removes empty task blocks on Enter and keeps a paragraph cursor target', () => {
    const paragraph = { id: 'paragraph-1', type: 'paragraph', props: {}, children: [] } as any
    const block = makeBlock({ title: '' })
    const editor = makeEditor([paragraph, block])
    mocks.taskState.task = null

    render(<TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />)

    const input = screen.getByDisplayValue('')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.deleteTask).toHaveBeenCalledWith('task-1')
    expect(editor.removeBlocks).toHaveBeenCalledWith([block])
    expect(editor.insertBlocks).toHaveBeenCalledWith([{ type: 'paragraph' }], paragraph, 'after')
    expect(editor.setTextCursorPosition).toHaveBeenCalled()
    expect(editor.focus).toHaveBeenCalled()
  })

  it('removes empty task blocks on Backspace and focuses previous paragraphs', () => {
    const paragraph = { id: 'paragraph-1', type: 'paragraph', props: {}, children: [] } as any
    const block = makeBlock({ title: '' })
    const editor = makeEditor([paragraph, block])
    mocks.taskState.task = null

    render(<TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />)

    fireEvent.keyDown(screen.getByDisplayValue(''), { key: 'Backspace' })

    expect(mocks.deleteTask).toHaveBeenCalledWith('task-1')
    expect(editor.removeBlocks).toHaveBeenCalledWith([block])
    expect(editor.setTextCursorPosition).toHaveBeenCalledWith('paragraph-1', 'end')
    expect(editor.focus).toHaveBeenCalled()
  })

  it('guards task row actions when no task id exists', async () => {
    const editor = makeEditor()
    const block = makeBlock({ taskId: '', title: '' })
    mocks.taskState.task = null

    render(<TaskBlockRenderer block={block} editor={editor} contentRef={vi.fn()} />)

    fireEvent.click(screen.getByText('toggle'))
    fireEvent.click(screen.getByText('priority'))
    fireEvent.click(screen.getByText('project'))
    await act(async () => Promise.resolve())

    expect(editor.updateBlock).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.uncomplete).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
