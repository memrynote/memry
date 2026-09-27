import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import type { Task } from '@/data/task-model'
import { TaskBlockProperties } from './task-block-properties'
import { AddPropertyMenu } from './add-property-menu'
import type { TaskPropertyId } from './task-property-ids'

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))
vi.mock('@/hooks/use-notes-query', () => ({ useNoteTagsQuery: () => ({ tags: [] }) }))
vi.mock('@/components/tasks/task-reminder-button', () => ({
  TaskReminderButton: ({ open }: { open?: boolean }) => (
    <button type="button">{open ? 'reminder picker' : 'reminder chip'}</button>
  )
}))
vi.mock('@/components/tasks/task-description-editor', () => ({
  TaskDescriptionEditor: ({ onContentChange }: { onContentChange: (md: string) => void }) => (
    <textarea aria-label="description editor" onChange={(e) => onContentChange(e.target.value)} />
  )
}))
vi.mock('@/components/filing/tag-autocomplete', () => ({
  TagAutocomplete: ({
    tags,
    onTagsChange
  }: {
    tags: string[]
    onTagsChange: (tags: string[]) => void
  }) => (
    <button type="button" onClick={() => onTagsChange([...tags, 'beta'])}>
      add beta
    </button>
  )
}))
vi.mock('@/components/tasks/use-related-item-search', () => ({
  useRelatedItemSearch: () => ({ notes: [], canvases: [] })
}))
vi.mock('@/components/tasks/use-related-item-info', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/tasks/use-related-item-info')>()
  return {
    ...actual,
    useRelatedItemInfo: (noteIds: string[] = [], canvasIds: string[] = []) => ({
      refs: [
        ...noteIds.map((id) => ({ kind: 'note' as const, id })),
        ...canvasIds.map((id) => ({ kind: 'canvas' as const, id }))
      ],
      infoByKey: Object.fromEntries(
        noteIds.map((id) => [
          `note:${id}`,
          { kind: 'note', title: `Note ${id}`, fileType: 'markdown' }
        ])
      ),
      remember: vi.fn(),
      forget: vi.fn()
    })
  }
})

const today = (): Date => {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Ship the beta',
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'none',
  startDate: null,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  linkedNoteIds: ['host-note'],
  linkedCanvasIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(2026, 0, 1),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const handlers = {
  onUpdate: vi.fn(),
  onDescriptionChange: vi.fn(),
  onTagsChange: vi.fn(),
  onOpenRelatedItem: vi.fn()
}

// The block owns which picker is open; this stands in for it.
const Harness = ({
  task,
  initialOpen = null
}: {
  task: Task
  initialOpen?: TaskPropertyId | null
}): React.JSX.Element => {
  const [open, setOpen] = useState<TaskPropertyId | null>(initialOpen)
  return (
    <TaskBlockProperties
      task={task}
      isCompleted={false}
      hasActiveReminder={false}
      hostNoteId="host-note"
      projectColor="#000"
      open={open}
      onOpenChange={(id, next) => setOpen((prev) => (next ? id : prev === id ? null : prev))}
      {...handlers}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TaskBlockProperties', () => {
  it('shows nothing for a task with no optional properties', () => {
    render(<Harness task={makeTask()} />)

    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('shows a chip for each property that is set', () => {
    render(
      <Harness
        task={makeTask({
          description: '# Plan\nCut from main',
          tags: ['launch', 'release', 'q3'],
          startDate: new Date(2026, 8, 5),
          dueDate: new Date(2099, 8, 12),
          dueTime: '09:00',
          isRepeating: true,
          repeatConfig: {
            frequency: 'weekly',
            interval: 1,
            daysOfWeek: [5],
            endType: 'never',
            endDate: null,
            completedCount: 0,
            createdAt: new Date(2026, 0, 1)
          },
          linkedNoteIds: ['host-note', 'note-2'],
          linkedCanvasIds: []
        })}
      />
    )

    expect(screen.getByRole('button', { name: 'Description: Plan' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Repeat: / })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tags: launch, release, q3' })).toHaveTextContent(
      'launchrelease+1'
    )
    expect(
      screen.getByRole('button', { name: /^Dates: Sep 5 → Sep 12, 09:00$/ })
    ).toBeInTheDocument()
    // The note holding the block is linked, but it is not "related".
    expect(screen.getByRole('button', { name: 'Related items: 1' })).toHaveTextContent('1')
  })

  it('reads start-only dates with a trailing arrow and flags an overdue due date', () => {
    const { rerender } = render(<Harness task={makeTask({ startDate: new Date(2026, 8, 5) })} />)
    expect(screen.getByRole('button', { name: 'Dates: Sep 5 →' })).toBeInTheDocument()

    rerender(<Harness task={makeTask({ dueDate: new Date(2020, 0, 2) })} />)
    expect(screen.getByRole('button', { name: /^Dates: / }).className).toContain('text-destructive')
  })

  it('sets the due date from the picker and closes it', () => {
    render(<Harness task={makeTask()} initialOpen="due" />)

    expect(screen.getByRole('radio', { name: 'Due' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /^Today/ }))

    expect(handlers.onUpdate).toHaveBeenCalledWith({ dueDate: today() })
    expect(screen.queryByRole('radio', { name: 'Due' })).not.toBeInTheDocument()
  })

  it('opens on the start segment when asked for the start date', () => {
    render(<Harness task={makeTask()} initialOpen="start" />)

    expect(screen.getByRole('radio', { name: 'Start' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /^Today/ }))

    expect(handlers.onUpdate).toHaveBeenCalledWith({ startDate: today() })
  })

  it('takes the time with it when the due date is removed', () => {
    render(
      <Harness
        task={makeTask({ dueDate: new Date(2099, 0, 2), dueTime: '09:00' })}
        initialOpen="due"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove date' }))

    expect(handlers.onUpdate).toHaveBeenCalledWith({ dueDate: null, dueTime: null })
  })

  it('mounts an empty property as a chip while its picker is open', () => {
    render(<Harness task={makeTask()} initialOpen="tags" />)

    fireEvent.click(screen.getByRole('button', { name: 'add beta' }))
    expect(handlers.onTagsChange).toHaveBeenCalledWith(['beta'])
    expect(screen.getByRole('button', { name: 'Tags' })).toBeInTheDocument()
  })

  it('opens a related item from its picker', () => {
    render(
      <Harness task={makeTask({ linkedNoteIds: ['host-note', 'note-2'] })} initialOpen="related" />
    )

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByText('Note host-note')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Note note-2' }))

    expect(handlers.onOpenRelatedItem).toHaveBeenCalledWith(
      { kind: 'note', id: 'note-2' },
      'Note note-2'
    )
  })
})

describe('AddPropertyMenu', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  it('renders nothing once the task has every property', () => {
    render(<AddPropertyMenu items={[]} onPick={vi.fn()} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('lists only the missing properties and hands a pick to the chip', async () => {
    const onPick = vi.fn()
    render(<AddPropertyMenu items={['start', 'tags']} onPick={onPick} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Add property' }), { key: 'Enter' })
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Start date⇧D', 'TagsL'])

    await act(async () => {
      fireEvent.click(items[1])
    })
    expect(onPick).toHaveBeenCalledWith('tags')
  })

  it('answers the row keys while open', async () => {
    const onPick = vi.fn()
    render(<AddPropertyMenu items={['due', 'start']} onPick={onPick} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Add property' }), { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    fireEvent.keyDown(menu, { key: 'D', shiftKey: true })

    expect(onPick).toHaveBeenCalledWith('start')
  })
})
