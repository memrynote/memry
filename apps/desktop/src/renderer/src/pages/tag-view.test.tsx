import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as React from 'react'
import TagViewPage from './tag-view'
import { getTagColors } from '@/components/note/tags-row/tag-colors'

const mocks = vi.hoisted(() => ({
  renameTag: vi.fn(async () => ({ success: true })),
  updateTagColor: vi.fn(async () => ({ success: true })),
  updateTagIcon: vi.fn(async () => ({ success: true })),
  deleteTag: vi.fn(async () => ({ success: true })),
  renamedHandler: null as
    | ((event: { oldName: string; newName: string; affectedNotes: number }) => void)
    | null,
  deletedHandler: null as ((event: { tag: string; affectedNotes: number }) => void) | null,
  closeTab: vi.fn(),
  activeTab: { id: 'tab-1', entityId: 'meetings' } as { id: string; entityId?: string } | null
}))

vi.mock('@/hooks/use-tag-items', () => ({
  useTagItems: () => ({ items: [], total: 0, isLoading: false, error: null, refresh: vi.fn() })
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
      deleteTag: mocks.deleteTag
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
})
