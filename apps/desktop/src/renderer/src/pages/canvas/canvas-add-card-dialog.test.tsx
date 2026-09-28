import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// cmdk scrolls the highlighted item into view on selection change; jsdom has
// no layout engine, so Element.prototype.scrollIntoView doesn't exist. Same
// shim as components/capture-bar/capture-bar.test.tsx.
Element.prototype.scrollIntoView = vi.fn()

interface Sources {
  results: unknown[]
  files?: unknown[]
  events: unknown[]
  projects?: unknown[]
  loading: boolean
}

const mocks = vi.hoisted(() => ({
  sources: { results: [], events: [], loading: false } as Sources,
  tags: [] as { name: string; count: number }[],
  folders: [] as string[],
  scopeOptions: [] as {
    viewName: string | null
    refs: { entityType: 'note' | 'task' | 'file'; entityId: string }[]
  }[],
  loadScope: vi.fn()
}))

// Production react-i18next hands back a referentially-stable `t` across
// renders, so the mock does too — a fresh `t` (or a fresh `{ t }` wrapper)
// every call would give the dialog's `groups` memo a new identity on every
// render regardless of its own deps, masking whether the highlight effect's
// dependency array is actually correct.
vi.mock('@memry/i18n/renderer', () => {
  const t = (key: string, vars?: Record<string, unknown>) => {
    const last = key.split('.').at(-1) ?? key
    const filled = vars?.query ?? vars?.date
    return filled === undefined ? last : `${last}:${String(filled)}`
  }
  const useTResult = { t }
  return {
    useT: () => useTResult
  }
})
vi.mock('./use-canvas-add-search', () => ({
  useCanvasAddSearch: () => ({
    ...mocks.sources,
    files: mocks.sources.files ?? [],
    projects: mocks.sources.projects ?? []
  })
}))

vi.mock('./canvas-bulk-sources', () => ({
  listBulkTags: async () => mocks.tags,
  listBulkFolders: async () => mocks.folders,
  loadBulkScopeOptions: (scope: unknown) => {
    mocks.loadScope(scope)
    return Promise.resolve(mocks.scopeOptions)
  }
}))

import { CanvasAddCardDialog } from './canvas-add-card-dialog'
import { BULK_ADD_CONFIRM_THRESHOLD } from './canvas-bulk-add'

function noteResult(id: string, title: string) {
  return { id, type: 'note', title, metadata: { type: 'note', path: `n/${title}.md`, tags: [] } }
}
function taskResult(id: string, title: string) {
  return { id, type: 'task', title, metadata: { type: 'task', projectName: 'Inbox' } }
}
function fileResult(id: string, title: string) {
  return {
    id,
    type: 'note',
    title,
    metadata: { type: 'note', path: `Docs/${title}`, tags: [], fileType: 'pdf' }
  }
}
function project(id: string, name: string, archivedAt: string | null = null) {
  return { id, name, color: '#3366ff', archivedAt, taskCount: 4, completedCount: 1 }
}
function eventItem(id: string, title: string) {
  return { id, title, startAt: '2026-07-22T09:00:00.000Z', endAt: null, isAllDay: false }
}

function setup(overrides: Partial<Parameters<typeof CanvasAddCardDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onCanvasKeys: new Set<string>(),
    onCreateNote: vi.fn(),
    onPick: vi.fn(),
    onReveal: vi.fn(),
    onAddAll: vi.fn(),
    ...overrides
  }
  const { rerender } = render(<CanvasAddCardDialog {...props} />)
  return { ...props, rerender: () => rerender(<CanvasAddCardDialog {...props} />) }
}

describe('CanvasAddCardDialog', () => {
  beforeEach(() => {
    mocks.sources = { results: [], events: [], loading: false }
  })

  it('dims the canvas behind it with a backdrop scrim', () => {
    setup()
    // cmdk puts `className` on the Command root, so the scrim can only come
    // from `overlayClassName` landing on Radix's [cmdk-overlay]. See #872.
    const overlay = document.querySelector('[cmdk-overlay]')
    expect(overlay).not.toBeNull()
    expect(overlay?.className).toContain('bg-black/50')
  })

  it('offers create-new-note when the query is empty', () => {
    const props = setup()
    fireEvent.click(screen.getByTestId('canvas-add-create-note'))
    expect(props.onCreateNote).toHaveBeenCalledWith('')
  })

  it('renders all three groups', async () => {
    mocks.sources = {
      results: [noteResult('n1', 'Alpha'), taskResult('t1', 'Ship it')],
      events: [eventItem('e1', 'Standup')],
      loading: false
    }
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'a' } })
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByText('Ship it')).toBeInTheDocument()
    expect(screen.getByText('Standup')).toBeInTheDocument()
  })

  it('places a filed file as a file card and a project found by name', async () => {
    mocks.sources = {
      results: [],
      files: [fileResult('f1', 'Brief.pdf')],
      events: [],
      projects: [
        project('p1', 'Launch'),
        project('p2', 'Archive me', '2026-01-01'),
        project('p3', 'Other')
      ],
      loading: false
    }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'la' } })

    await waitFor(() =>
      expect(screen.getByTestId('canvas-add-item-project:p1')).toBeInTheDocument()
    )
    expect(screen.queryByTestId('canvas-add-item-project:p2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('canvas-add-item-project:p3')).not.toBeInTheDocument()
    expect(screen.queryByTestId('canvas-add-item-note:f1')).not.toBeInTheDocument()
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.getByText('1/4')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('canvas-add-item-file:f1'))
    expect(props.onPick).toHaveBeenCalledWith('file', 'f1')
  })

  describe('row rendering', () => {
    // The picker is a placement surface: a row has to say "note" / "task" /
    // "event" on sight, the way the sidebar and the task list already do.
    async function renderQuery(sources: typeof mocks.sources, anchor: string) {
      mocks.sources = sources
      setup()
      fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'a' } })
      await waitFor(() => expect(screen.getByText(anchor)).toBeInTheDocument())
    }

    it("shows a note's own icon, its path and when it was created", async () => {
      // #given — a note carrying an emoji icon
      await renderQuery(
        {
          results: [
            {
              id: 'n1',
              type: 'note',
              title: 'Alpha',
              metadata: {
                type: 'note',
                path: 'n/Alpha.md',
                tags: [],
                emoji: '📌',
                createdAt: '2026-06-01T00:00:00.000Z'
              }
            }
          ],
          events: [],
          loading: false
        },
        'Alpha'
      )

      // #then — the note's identity, not a bare title/subtitle pair
      expect(screen.getByText('📌')).toBeInTheDocument()
      expect(screen.getByText('n/Alpha.md')).toBeInTheDocument()
      expect(screen.getByText(/addCreatedAt:/)).toBeInTheDocument()
    })

    it("shows a task's project, status, priority and due date", async () => {
      // #given — a task with every property the task list would show
      await renderQuery(
        {
          results: [
            {
              id: 't1',
              type: 'task',
              title: 'Ship it',
              metadata: {
                type: 'task',
                projectName: 'Inbox',
                projectColor: '#ff671a',
                statusId: 's1',
                statusName: 'In progress',
                dueDate: '2026-08-01',
                priority: 4,
                completedAt: null,
                createdAt: '2026-06-01T00:00:00.000Z'
              }
            }
          ],
          events: [],
          loading: false
        },
        'Ship it'
      )

      // #then — the same vocabulary the task list uses, priority label included
      expect(screen.getByText('Inbox')).toBeInTheDocument()
      expect(screen.getByText('In progress')).toBeInTheDocument()
      expect(screen.getByText('Urgent')).toBeInTheDocument()
      // Aug 1, not Jul 31 — the date-only due date must not shift westward.
      expect(screen.getByText(/Aug/)).toBeInTheDocument()
    })

    it('shows an event as a time, never as a raw ISO string', async () => {
      // #given — a timed calendar event
      await renderQuery(
        { results: [], events: [eventItem('e1', 'Standup')], loading: false },
        'Standup'
      )

      // #then — humanized, like the calendar card renders it
      expect(screen.queryByText('2026-07-22T09:00:00.000Z')).not.toBeInTheDocument()
      expect(screen.getByText(/Jul/)).toBeInTheDocument()
    })
  })

  it('picks a fresh entity', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], events: [], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('canvas-add-item-task:t1'))
    expect(props.onPick).toHaveBeenCalledWith('task', 't1')
    expect(props.onReveal).not.toHaveBeenCalled()
  })

  it('reveals instead of duplicating an entity already on the canvas', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], events: [], loading: false }
    const props = setup({ onCanvasKeys: new Set(['task:t1']) })
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    expect(screen.getByText('addOnCanvas')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('canvas-add-item-task:t1'))
    expect(props.onReveal).toHaveBeenCalledWith('task', 't1')
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('keeps the create row visible while typing and carries the query', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], events: [], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'groceries' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('canvas-add-create-note'))
    expect(props.onCreateNote).toHaveBeenCalledWith('groceries')
  })

  it('hides the empty state for a blank query', () => {
    setup()
    expect(screen.queryByTestId('canvas-add-empty')).not.toBeInTheDocument()
  })

  it('shows the empty state when a non-blank query has no matches', () => {
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'nomatch' } })
    expect(screen.getByTestId('canvas-add-empty')).toBeInTheDocument()
  })

  it('hides the empty state once matches exist', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], events: [], loading: false }
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    expect(screen.queryByTestId('canvas-add-empty')).not.toBeInTheDocument()
  })

  it('keeps the create row highlighted for a blank query', () => {
    // The hook (tested separately) never returns events for a blank query, so
    // this mocks the state it actually produces — the dialog itself no longer
    // filters by query (#869).
    mocks.sources = {
      results: [],
      events: [],
      loading: false
    }
    const props = setup()
    fireEvent.keyDown(screen.getByTestId('canvas-add-input'), { key: 'Enter' })
    expect(props.onCreateNote).toHaveBeenCalledWith('')
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('keeps the create row highlighted for a blank query even when a stale event is present', () => {
    // The hook clears `events` in its own effect (#869), so for one render
    // after the user clears the input, groups.calendar_event can still hold
    // a stale match. The highlight effect must prefer the create row anyway,
    // or Enter would add that stale event instead of creating a note.
    mocks.sources = {
      results: [],
      events: [eventItem('e1', 'Standup')],
      loading: false
    }
    const props = setup()
    fireEvent.keyDown(screen.getByTestId('canvas-add-input'), { key: 'Enter' })
    expect(props.onCreateNote).toHaveBeenCalledWith('')
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('suppresses the empty state while a search is in flight', () => {
    mocks.sources = { results: [], events: [], loading: true }
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    expect(screen.queryByTestId('canvas-add-empty')).not.toBeInTheDocument()
  })

  it('lets Enter pick the first match instead of creating a note', async () => {
    const props = setup()
    // Type before results exist, matching the real debounced-search timing:
    // the query settles first, then results land in a later render. Changing
    // both on the same render races cmdk's own value reset (it re-picks the
    // first mounted item on every keystroke) against our own effect.
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'a' } })
    mocks.sources = {
      results: [taskResult('t1', 'Ship it'), noteResult('n1', 'Alpha')],
      events: [],
      loading: false
    }
    props.rerender()
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-note:n1')).toBeInTheDocument())
    fireEvent.keyDown(screen.getByTestId('canvas-add-input'), { key: 'Enter' })
    expect(props.onPick).toHaveBeenCalledWith('note', 'n1')
    expect(props.onCreateNote).not.toHaveBeenCalled()
  })

  it('re-highlights the create row when the query clears before events catches up', async () => {
    // The real hook clears `events` one render after the query does (#869),
    // so mirror that here: keep `mocks.sources.events` populated across the
    // clear instead of resetting it. With a stable `t`, `groups` keeps its
    // identity across this transition too, so the highlight effect only
    // notices the clear if `query` is in its own dependency array.
    mocks.sources = { results: [], events: [eventItem('e1', 'Standup')], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'stand' } })
    await waitFor(() =>
      expect(screen.getByTestId('canvas-add-item-calendar_event:e1')).toHaveAttribute(
        'data-selected',
        'true'
      )
    )

    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: '' } })
    fireEvent.keyDown(screen.getByTestId('canvas-add-input'), { key: 'Enter' })
    expect(props.onCreateNote).toHaveBeenCalledWith('')
    expect(props.onPick).not.toHaveBeenCalled()
  })
  describe('add all from a tag, folder or saved view (#2484)', () => {
    function notes(count: number, prefix = 'n') {
      return Array.from({ length: count }, (_, i) => ({
        entityType: 'note' as const,
        entityId: `${prefix}${i}`
      }))
    }

    beforeEach(() => {
      mocks.tags = [
        { name: 'research', count: 3 },
        { name: 'reading', count: 1 }
      ]
      mocks.folders = ['Projects', 'Projects/2026']
      mocks.scopeOptions = []
      mocks.loadScope.mockReset()
    })

    it('offers the bulk sources only for a blank query', () => {
      setup()
      expect(screen.getByTestId('canvas-add-bulk-tag')).toBeInTheDocument()
      expect(screen.getByTestId('canvas-add-bulk-folder')).toBeInTheDocument()
      fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'x' } })
      expect(screen.queryByTestId('canvas-add-bulk-tag')).not.toBeInTheDocument()
    })

    it('adds every item of a tag without views in one step and closes', async () => {
      mocks.scopeOptions = [{ viewName: null, refs: notes(3) }]
      const props = setup()
      fireEvent.click(screen.getByTestId('canvas-add-bulk-tag'))
      // The tag list filters on the same input.
      fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'resea' } })
      await waitFor(() =>
        expect(screen.getByTestId('canvas-add-bulk-tag-research')).toBeInTheDocument()
      )
      expect(screen.queryByTestId('canvas-add-bulk-tag-reading')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('canvas-add-bulk-tag-research'))

      await waitFor(() => expect(props.onAddAll).toHaveBeenCalledWith(notes(3)))
      expect(mocks.loadScope).toHaveBeenCalledWith({ kind: 'tag', tag: 'research' })
      expect(props.onOpenChange).toHaveBeenCalledWith(false)
    })

    it('lets a folder with filtering saved views add one view', async () => {
      mocks.scopeOptions = [
        { viewName: null, refs: notes(3) },
        { viewName: 'Open', refs: notes(1, 'open') }
      ]
      const props = setup()
      fireEvent.click(screen.getByTestId('canvas-add-bulk-folder'))
      fireEvent.click(await screen.findByTestId('canvas-add-bulk-folder-Projects/2026'))

      fireEvent.click(await screen.findByTestId('canvas-add-bulk-view-1'))

      expect(mocks.loadScope).toHaveBeenCalledWith({ kind: 'folder', path: 'Projects/2026' })
      expect(props.onAddAll).toHaveBeenCalledWith(notes(1, 'open'))
    })

    it('asks before placing more new cards than the threshold', async () => {
      const refs = notes(BULK_ADD_CONFIRM_THRESHOLD + 5)
      mocks.scopeOptions = [{ viewName: null, refs }]
      const props = setup()
      fireEvent.click(screen.getByTestId('canvas-add-bulk-tag'))
      fireEvent.click(await screen.findByTestId('canvas-add-bulk-tag-research'))

      await screen.findByTestId('canvas-add-bulk-confirm')
      expect(props.onAddAll).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId('canvas-add-bulk-confirm-add'))
      expect(props.onAddAll).toHaveBeenCalledWith(refs)
    })

    it('does not count items already on the board toward the threshold', async () => {
      const refs = notes(BULK_ADD_CONFIRM_THRESHOLD + 5)
      mocks.scopeOptions = [{ viewName: null, refs }]
      const onCanvasKeys = new Set(refs.slice(0, 10).map((ref) => `note:${ref.entityId}`))
      const props = setup({ onCanvasKeys })
      fireEvent.click(screen.getByTestId('canvas-add-bulk-tag'))
      fireEvent.click(await screen.findByTestId('canvas-add-bulk-tag-research'))

      await waitFor(() => expect(props.onAddAll).toHaveBeenCalledWith(refs))
      expect(screen.queryByTestId('canvas-add-bulk-confirm')).not.toBeInTheDocument()
    })

    it('steps back to the source list from the confirm step', async () => {
      mocks.scopeOptions = [{ viewName: null, refs: notes(BULK_ADD_CONFIRM_THRESHOLD + 1) }]
      const props = setup()
      fireEvent.click(screen.getByTestId('canvas-add-bulk-tag'))
      fireEvent.click(await screen.findByTestId('canvas-add-bulk-tag-research'))
      fireEvent.click(await screen.findByTestId('canvas-add-bulk-confirm-back'))

      expect(await screen.findByTestId('canvas-add-bulk-tag-research')).toBeInTheDocument()
      expect(props.onAddAll).not.toHaveBeenCalled()
    })

    it('goes back to search on Backspace in an empty input', async () => {
      setup()
      fireEvent.click(screen.getByTestId('canvas-add-bulk-tag'))
      await screen.findByTestId('canvas-add-bulk-tag-research')
      fireEvent.keyDown(screen.getByTestId('canvas-add-input'), { key: 'Backspace' })
      expect(screen.getByTestId('canvas-add-create-note')).toBeInTheDocument()
    })
  })
})
