import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as React from 'react'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import TagViewPage from './tag-view'
import { getTagColors } from '@/components/note/tags-row/tag-colors'

interface TagItemsMockResult {
  items: NoteWithProperties[]
  total: number
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const mocks = vi.hoisted(() => ({
  renameTag: vi.fn(async () => ({ success: true })),
  updateTagColor: vi.fn(async () => ({ success: true })),
  updateTagIcon: vi.fn(async () => ({ success: true })),
  deleteTag: vi.fn(async () => ({ success: true })),
  pinNoteToTag: vi.fn(async () => ({ success: true })),
  renamedHandler: null as
    | ((event: { oldName: string; newName: string; affectedNotes: number }) => void)
    | null,
  deletedHandler: null as ((event: { tag: string; affectedNotes: number }) => void) | null,
  closeTab: vi.fn(),
  activeTab: { id: 'tab-1', entityId: 'meetings' } as { id: string; entityId?: string } | null,
  openSidebarItem: vi.fn(),
  tagItems: {
    items: [],
    total: 0,
    isLoading: false,
    error: null,
    refresh: vi.fn(async () => {})
  } as TagItemsMockResult
}))

vi.mock('@/hooks/use-tag-items', () => ({
  useTagItems: () => mocks.tagItems
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))

// The real Picker renders through a Radix Popover (positioning APIs jsdom
// doesn't have) — mocked the same way `inbox.test.tsx` mocks it: content
// always in the DOM, `Picker.Item` notifies the nearest `Picker`'s
// `onValueChange` directly instead of going through the real context.
vi.mock('@/components/ui/picker', () => {
  let currentOnValueChange: (value: string) => void = () => {}

  function Picker({
    onValueChange,
    children
  }: {
    onValueChange?: (value: string) => void
    children: React.ReactNode
  }) {
    currentOnValueChange = onValueChange ?? (() => {})
    return <>{children}</>
  }
  Picker.Trigger = ({ children }: { children: React.ReactNode }) => <>{children}</>
  Picker.Content = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  Picker.List = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  Picker.Item = ({ value, label, role }: { value: string; label: string; role?: string }) => (
    <button type="button" role={role ?? 'option'} onClick={() => currentOnValueChange(value)}>
      {label}
    </button>
  )

  return { Picker }
})

// Page-level tests exercise tag-view's own filtering/routing logic, not
// FolderTableView's internals (virtualization, dnd-kit column drag —
// already covered by folder-table-view.test.tsx). Mirrors the same stub
// approach `folder-view.test.tsx` uses for the same reason.
vi.mock('@/components/folder-view', () => ({
  FolderTableView: ({
    notes,
    onNoteOpen
  }: {
    notes: Array<{ id: string; title: string }>
    onNoteOpen?: (noteId: string) => void
  }) => (
    <div>
      {notes.map((note) => (
        <button key={note.id} type="button" onClick={() => onNoteOpen?.(note.id)}>
          {note.title}
        </button>
      ))}
    </div>
  )
}))

// A stored color deliberately different from `meetings`' name-hash fallback
// (verified below) — this is what the hub chip / sidebar would have resolved
// from `tag_definitions.color`.
const STORED_COLOR = 'cobalt'

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({
    tags: [
      { tag: 'meetings', color: STORED_COLOR, count: 3, icon: null, categoryId: null, sortOrder: 0 }
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn()
  })
}))

vi.mock('@/services/tags-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/tags-service')>()
  return {
    ...actual,
    tagsService: {
      ...actual.tagsService,
      renameTag: mocks.renameTag,
      updateTagColor: mocks.updateTagColor,
      updateTagIcon: mocks.updateTagIcon,
      deleteTag: mocks.deleteTag,
      pinNoteToTag: mocks.pinNoteToTag
    },
    onTagRenamed: (
      handler: (event: { oldName: string; newName: string; affectedNotes: number }) => void
    ) => {
      mocks.renamedHandler = handler
      return vi.fn()
    },
    onTagDeleted: (handler: (event: { tag: string; affectedNotes: number }) => void) => {
      mocks.deletedHandler = handler
      return vi.fn()
    }
  }
})

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    closeTab: mocks.closeTab
  }),
  useActiveTab: () => mocks.activeTab
}))

// jsdom normalizes inline hex colors to rgb() on readback, so compare via a
// probe element rather than the raw hex string from getTagColors.
function asCssColor(hex: string): string {
  const probe = document.createElement('div')
  probe.style.color = hex
  return probe.style.color
}

function renderWithTabs(
  ui: React.ReactElement,
  overrides: { closeTab?: ReturnType<typeof vi.fn> } = {}
) {
  mocks.closeTab = overrides.closeTab ?? vi.fn()
  return render(ui)
}

function renderWithNavigation(
  ui: React.ReactElement,
  overrides: { openSidebarItem?: ReturnType<typeof vi.fn> } = {}
) {
  mocks.openSidebarItem = overrides.openSidebarItem ?? vi.fn()
  return render(ui)
}

// Already-adapted rows (the shape `useTagItems` produces) — one of each
// kind, matching Task 15's `TagItem` fixture used by use-tag-items.test.ts.
const FIXTURE_ITEMS: NoteWithProperties[] = [
  {
    id: 'n1',
    path: '/notes/q3-kickoff.md',
    title: 'Q3 kickoff',
    emoji: null,
    folder: 'Notes',
    tags: ['meetings'],
    created: '2026-07-01T00:00:00Z',
    modified: '2026-07-02T00:00:00Z',
    wordCount: 0,
    properties: {},
    kind: 'note'
  },
  {
    id: 't1',
    path: '/tasks/t1',
    title: 'Ali ile 1:1',
    emoji: null,
    folder: 'Project X',
    tags: ['meetings'],
    created: '2026-07-20T00:00:00Z',
    modified: '2026-07-22T00:00:00Z',
    wordCount: 0,
    properties: {},
    kind: 'task'
  }
]

function useFixtureItems(): void {
  mocks.tagItems = {
    items: FIXTURE_ITEMS,
    total: FIXTURE_ITEMS.length,
    isLoading: false,
    error: null,
    refresh: vi.fn(async () => {})
  }
}

function emitTagDeleted(event: { tag: string }) {
  mocks.deletedHandler?.({ tag: event.tag, affectedNotes: 0 })
}

function emitTagRenamed(event: { oldName: string; newName: string }) {
  mocks.renamedHandler?.({ oldName: event.oldName, newName: event.newName, affectedNotes: 0 })
}

describe('TagViewPage', () => {
  it('shows the tag name and its total count in the header', () => {
    render(<TagViewPage tag="meetings" />)
    expect(screen.getByText('meetings')).toBeInTheDocument()
  })

  it("colors the header chip from the tag's stored color, not the name-hash fallback", () => {
    render(<TagViewPage tag="meetings" />)
    const chip = screen.getByText('meetings').parentElement as HTMLElement

    const storedColors = getTagColors(STORED_COLOR, 'meetings')
    const nameHashColors = getTagColors('', 'meetings')

    // Sanity check: the fixture only discriminates if these genuinely differ.
    expect(storedColors.text).not.toBe(nameHashColors.text)

    expect(chip.style.color).toBe(asCssColor(storedColors.text))
    expect(chip.style.color).not.toBe(asCssColor(nameHashColors.text))
  })

  it('offers rename, color, icon and delete', async () => {
    render(<TagViewPage tag="meetings" />)
    await userEvent.click(screen.getByRole('button', { name: /tag actions/i }))

    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /color/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument()
  })

  it('closes the tab when the tag is deleted elsewhere', async () => {
    const closeTab = vi.fn()
    renderWithTabs(<TagViewPage tag="meetings" />, { closeTab })

    emitTagDeleted({ tag: 'meetings' })

    await waitFor(() => expect(closeTab).toHaveBeenCalled())
  })

  it('closes the tab when the tag is renamed elsewhere', async () => {
    const closeTab = vi.fn()
    renderWithTabs(<TagViewPage tag="meetings" />, { closeTab })

    emitTagRenamed({ oldName: 'meetings', newName: 'standups' })

    await waitFor(() => expect(closeTab).toHaveBeenCalled())
  })

  it('does not close the tab when a different tag is deleted', async () => {
    const closeTab = vi.fn()
    renderWithTabs(<TagViewPage tag="meetings" />, { closeTab })

    emitTagDeleted({ tag: 'other' })

    // Give any (incorrect) async close a chance to fire before asserting.
    await waitFor(() => expect(screen.getByText('meetings')).toBeInTheDocument())
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('does not close the tab when a different tag is renamed', async () => {
    const closeTab = vi.fn()
    renderWithTabs(<TagViewPage tag="meetings" />, { closeTab })

    emitTagRenamed({ oldName: 'other', newName: 'renamed-other' })

    // Give any (incorrect) async close a chance to fire before asserting.
    await waitFor(() => expect(screen.getByText('meetings')).toBeInTheDocument())
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('filters to a single kind', async () => {
    useFixtureItems()
    render(<TagViewPage tag="meetings" />)
    await userEvent.click(screen.getByRole('button', { name: /all/i }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /tasks/i }))

    expect(screen.queryByText('Q3 kickoff')).not.toBeInTheDocument()
  })

  it('opens a task in the tasks tab', async () => {
    useFixtureItems()
    const openSidebarItem = vi.fn()
    renderWithNavigation(<TagViewPage tag="meetings" />, { openSidebarItem })

    await userEvent.click(screen.getByText('Ali ile 1:1'))

    expect(openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: expect.objectContaining({ openTaskId: 't1' })
      })
    )
  })
})
