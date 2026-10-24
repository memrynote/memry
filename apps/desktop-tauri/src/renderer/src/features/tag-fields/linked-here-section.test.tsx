import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkedHereGroup, LinkedNoteItem } from '@memry/contracts/tag-objects-api'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { FOLDER_VIEW_STATE_KEYS } from '@/pages/folder-view-state'
import { LinkedHereOrBacklinks, LinkedHereSection } from './linked-here-section'

const openTab = vi.fn()
vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab }) }))

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as {
  tags: Record<string, Fn>
  onNoteUpdated: Fn
  onTagsChanged: Fn
  onTaskUpdated: Fn
  onPropertyDefinitionChanged: Fn
}

const resolvedTag = (key: string): ResolvedTag => ({
  name: key,
  key,
  color: 'blue',
  icon: null,
  editable: true,
  ownFields: [],
  inherited: [],
  effectiveFields: [],
  hasFields: true,
  extends: null,
  ancestors: [],
  template: null,
  preset: null,
  ownPreset: null
})

const snapshot: TagSchemaSnapshot = {
  tags: { person: resolvedTag('person'), meeting: resolvedTag('meeting') },
  objects: { 'person-1': 'person' },
  presets: [],
  presetStripDismissed: false
}

const note = (n: number, extra: Partial<LinkedNoteItem> = {}): LinkedNoteItem => ({
  noteId: `n${n}`,
  title: `Note ${n}`,
  date: null,
  snippet: null,
  ...extra
})

function renderWithClient(ui: React.ReactElement): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['tags', 'schema-snapshot'], snapshot)
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
  return client
}

beforeEach(() => {
  openTab.mockClear()
  api.onNoteUpdated = vi.fn().mockReturnValue(() => {})
  api.onTagsChanged = vi.fn().mockReturnValue(() => {})
  api.onTaskUpdated = vi.fn().mockReturnValue(() => {})
  api.onPropertyDefinitionChanged = vi.fn().mockReturnValue(() => {})
  api.tags.getSchemaSnapshot = vi.fn().mockResolvedValue(snapshot)
})

const mockGroups = (groups: LinkedHereGroup[]): void => {
  api.tags.getLinkedHere = vi.fn().mockResolvedValue({ groups })
}

describe('LinkedHereOrBacklinks', () => {
  it('shows the plain backlinks fallback for a note that is not an object', () => {
    mockGroups([])
    renderWithClient(<LinkedHereOrBacklinks noteId="plain-note" fallback={<p>Backlinks</p>} />)

    expect(screen.getByText('Backlinks')).toBeInTheDocument()
    expect(api.tags.getLinkedHere).not.toHaveBeenCalled()
  })

  it('shows Linked here instead of the fallback for an object note', async () => {
    mockGroups([{ kind: 'mentions', total: 1, items: [note(1)] }])
    renderWithClient(<LinkedHereOrBacklinks noteId="person-1" fallback={<p>Backlinks</p>} />)

    expect(await screen.findByTestId('linked-here')).toBeInTheDocument()
    expect(screen.queryByText('Backlinks')).not.toBeInTheDocument()
  })

  it('holds a placeholder, never the fallback, until the schema snapshot says what the note is', async () => {
    mockGroups([{ kind: 'mentions', total: 1, items: [note(1)] }])
    let resolveSnapshot: (value: TagSchemaSnapshot) => void = () => {}
    api.tags.getSchemaSnapshot = vi.fn(
      () => new Promise<TagSchemaSnapshot>((resolve) => (resolveSnapshot = resolve))
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <LinkedHereOrBacklinks noteId="person-1" fallback={<p>Backlinks</p>} />
      </QueryClientProvider>
    )

    expect(screen.getByTestId('linked-here-pending')).toBeInTheDocument()
    expect(screen.queryByText('Backlinks')).not.toBeInTheDocument()

    await act(async () => resolveSnapshot(snapshot))

    expect(await screen.findByTestId('linked-here')).toBeInTheDocument()
    expect(screen.queryByText('Backlinks')).not.toBeInTheDocument()
  })
})

describe('LinkedHereOrBacklinks when the snapshot read fails', () => {
  it('falls back to plain backlinks instead of holding the placeholder', async () => {
    api.tags.getSchemaSnapshot = vi.fn().mockRejectedValue(new Error('ipc down'))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <LinkedHereOrBacklinks noteId="person-1" fallback={<p>Backlinks</p>} />
      </QueryClientProvider>
    )

    expect(await screen.findByText('Backlinks')).toBeInTheDocument()
    expect(screen.queryByTestId('linked-here-pending')).not.toBeInTheDocument()
  })
})

describe('LinkedHereSection', () => {
  it('holds a placeholder while the linked notes load', async () => {
    mockGroups([{ kind: 'mentions', total: 1, items: [note(1)] }])
    renderWithClient(<LinkedHereSection noteId="person-1" />)

    expect(screen.getByTestId('linked-here-pending')).toBeInTheDocument()
    expect(await screen.findByTestId('linked-here')).toBeInTheDocument()
    expect(screen.queryByTestId('linked-here-pending')).not.toBeInTheDocument()
  })

  it('renders nothing when no note or task links to the object', async () => {
    mockGroups([])
    renderWithClient(<LinkedHereSection noteId="person-1" />)

    await waitFor(() => expect(api.tags.getLinkedHere).toHaveBeenCalled())
    expect(screen.queryByTestId('linked-here')).not.toBeInTheDocument()
  })

  it('lists mentions with snippet or date and opens the clicked note in a tab', async () => {
    mockGroups([
      {
        kind: 'mentions',
        total: 2,
        items: [note(1, { snippet: 'met Ada at the conf' }), note(2, { date: '2026-04-09' })]
      }
    ])
    renderWithClient(<LinkedHereSection noteId="person-1" />)

    expect(await screen.findByText('Mentioned in')).toBeInTheDocument()
    expect(screen.getByText('in the text')).toBeInTheDocument()
    expect(screen.getByText('met Ada at the conf')).toBeInTheDocument()
    expect(screen.getByText('Apr 9')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Note 1/ }))

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Note 1',
        path: '/notes/n1',
        entityId: 'n1'
      })
    )
  })

  it('expands and collapses the mentions list from the count when more than two exist', async () => {
    api.tags.getLinkedHere = vi.fn(async ({ limitPerGroup }: { limitPerGroup: number }) => ({
      groups: [
        {
          kind: 'mentions',
          total: 4,
          items: [1, 2, 3, 4].slice(0, limitPerGroup).map((n) => note(n))
        }
      ]
    }))
    renderWithClient(<LinkedHereSection noteId="person-1" />)
    expect(await screen.findByText('Note 1')).toBeInTheDocument()
    expect(screen.queryByText('Note 4')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '4' }))
    expect(await screen.findByText('Note 4')).toBeInTheDocument()
    expect(api.tags.getLinkedHere).toHaveBeenCalledWith({ noteId: 'person-1', limitPerGroup: 500 })

    await userEvent.click(screen.getByRole('button', { name: '4' }))
    await waitFor(() => expect(screen.queryByText('Note 4')).not.toBeInTheDocument())
  })

  it('shows a relation group by label and field; its count opens the filtered tag table', async () => {
    mockGroups([
      {
        kind: 'relation',
        sourceTag: 'meeting',
        field: 'Attendees',
        label: 'Meetings',
        total: 5,
        items: [note(7, { title: 'Standup', date: '2026-03-05' })],
        filter: 'Attendees:person-1'
      }
    ])
    renderWithClient(<LinkedHereSection noteId="person-1" />)

    expect(await screen.findByText('Meetings')).toBeInTheDocument()
    expect(screen.getByText('as Attendees')).toBeInTheDocument()
    expect(screen.getByText('Mar 5')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '5' }))

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tag',
        path: '/tags/meeting',
        entityId: 'meeting',
        viewState: { [FOLDER_VIEW_STATE_KEYS.linkedFilter]: 'Attendees:person-1' }
      }),
      { forceNew: true }
    )

    await userEvent.click(screen.getByRole('button', { name: /Standup/ }))
    expect(openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'n7' })
    )
  })

  it('shows a relation group with no defining tag as a plain count', async () => {
    mockGroups([
      {
        kind: 'relation',
        sourceTag: '',
        field: 'Related',
        label: 'Related',
        total: 1,
        items: [note(3)],
        filter: ''
      }
    ])
    renderWithClient(<LinkedHereSection noteId="person-1" />)

    expect(await screen.findByText('Note 3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '1' })).not.toBeInTheDocument()
  })

  it('lists task-field links with due dates, strikes completed tasks and opens a task', async () => {
    mockGroups([
      {
        kind: 'task-field',
        tag: 'task',
        field: 'Owner',
        total: 2,
        items: [
          { taskId: 't1', title: 'Send agenda', dueDate: '2026-05-02', completed: false },
          { taskId: 't2', title: 'Book room', dueDate: null, completed: true }
        ],
        filter: 'Owner:person-1'
      }
    ])
    renderWithClient(<LinkedHereSection noteId="person-1" />)

    expect(await screen.findByText('Tasks')).toBeInTheDocument()
    expect(screen.getByText('as Owner')).toBeInTheDocument()
    expect(screen.getByText('Due May 2')).toBeInTheDocument()
    expect(screen.getByText('Book room')).toHaveClass('line-through')
    expect(screen.getByText('Send agenda')).not.toHaveClass('line-through')

    await userEvent.click(screen.getByRole('button', { name: /Send agenda/ }))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        path: '/tasks',
        viewState: expect.objectContaining({ openTaskId: 't1' })
      })
    )

    await userEvent.click(screen.getByRole('button', { name: '2' }))
    expect(openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'tag', path: '/tags/task' }),
      { forceNew: true }
    )
  })

  it.each([
    ['a note update', 'onNoteUpdated'],
    ['a tag change', 'onTagsChanged'],
    ['a task update', 'onTaskUpdated']
  ] as const)('reloads the groups shortly after %s', async (_label, channel) => {
    mockGroups([{ kind: 'mentions', total: 1, items: [note(1)] }])
    renderWithClient(<LinkedHereSection noteId="person-1" />)
    expect(await screen.findByText('Note 1')).toBeInTheDocument()
    const before = api.tags.getLinkedHere.mock.calls.length
    const emit = (): void =>
      api[channel].mock.calls.forEach(([cb]) =>
        (cb as (event: unknown) => void)({ id: 'person-1', changes: {} })
      )

    mockGroups([{ kind: 'mentions', total: 1, items: [note(9)] }])
    act(() => {
      emit()
      emit()
    })

    expect(await screen.findByText('Note 9')).toBeInTheDocument()
    expect(screen.queryByText('Note 1')).not.toBeInTheDocument()
    expect(api.tags.getLinkedHere.mock.calls.length).toBeGreaterThan(before)
  })

  it('unsubscribes from note, tag and task events when it unmounts', async () => {
    const offs = [vi.fn(), vi.fn(), vi.fn()]
    api.onNoteUpdated = vi.fn().mockReturnValue(offs[0])
    api.onTagsChanged = vi.fn().mockReturnValue(offs[1])
    api.onTaskUpdated = vi.fn().mockReturnValue(offs[2])
    mockGroups([])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <LinkedHereSection noteId="person-1" />
      </QueryClientProvider>
    )
    await waitFor(() => expect(api.tags.getLinkedHere).toHaveBeenCalled())

    view.unmount()

    for (const off of offs) expect(off).toHaveBeenCalled()
  })
})
