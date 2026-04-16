import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TagDetailView } from './tag-detail-view'

const {
  mockRenameTag,
  mockDeleteTag,
  mockUpdateTagColor,
  mockGetNotesByTag,
  mockPinNoteToTag,
  mockUnpinNoteFromTag,
  mockRemoveTagFromNote,
  mockGetAllWithCounts,
  mockMergeTag,
  mockOnTagRenamed,
  mockOnTagDeleted,
  mockOnTagNotesChanged,
  mockOnTagColorUpdated,
  mockToastSuccess,
  mockToastError,
  mockGoBack,
  mockOpenSidebarItem
} = vi.hoisted(() => ({
  mockRenameTag: vi.fn(),
  mockDeleteTag: vi.fn(),
  mockUpdateTagColor: vi.fn(),
  mockGetNotesByTag: vi.fn(),
  mockPinNoteToTag: vi.fn(),
  mockUnpinNoteFromTag: vi.fn(),
  mockRemoveTagFromNote: vi.fn(),
  mockGetAllWithCounts: vi.fn(),
  mockMergeTag: vi.fn(),
  mockOnTagRenamed: vi.fn(() => () => {}),
  mockOnTagDeleted: vi.fn(() => () => {}),
  mockOnTagNotesChanged: vi.fn(() => () => {}),
  mockOnTagColorUpdated: vi.fn(() => () => {}),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockGoBack: vi.fn(),
  mockOpenSidebarItem: vi.fn()
}))

vi.mock('@/services/tags-service', () => ({
  tagsService: {
    getNotesByTag: mockGetNotesByTag,
    pinNoteToTag: mockPinNoteToTag,
    unpinNoteFromTag: mockUnpinNoteFromTag,
    renameTag: mockRenameTag,
    updateTagColor: mockUpdateTagColor,
    deleteTag: mockDeleteTag,
    removeTagFromNote: mockRemoveTagFromNote,
    getAllWithCounts: mockGetAllWithCounts,
    mergeTag: mockMergeTag
  },
  onTagRenamed: mockOnTagRenamed,
  onTagDeleted: mockOnTagDeleted,
  onTagNotesChanged: mockOnTagNotesChanged,
  onTagColorUpdated: mockOnTagColorUpdated
}))

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError
  }
}))

vi.mock('@/contexts/sidebar-drill-down', () => ({
  useSidebarDrillDown: () => ({
    viewStack: [],
    currentView: { type: 'tag', tag: 'react', color: 'blue' },
    isAtMain: false,
    animationDirection: null,
    openTag: vi.fn(),
    goBack: mockGoBack,
    resetToMain: vi.fn()
  })
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({
    openSidebarItem: mockOpenSidebarItem
  })
}))

const defaultNotesResponse = {
  tag: 'react',
  color: 'blue',
  count: 0,
  pinnedNotes: [],
  unpinnedNotes: []
}

const success = { success: true as const }

describe('TagDetailView rename + delete actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetNotesByTag.mockResolvedValue(defaultNotesResponse)
    mockRenameTag.mockResolvedValue(success)
    mockDeleteTag.mockResolvedValue(success)
    ;(mockOnTagRenamed as Mock).mockReturnValue(() => {})
    ;(mockOnTagDeleted as Mock).mockReturnValue(() => {})
    ;(mockOnTagNotesChanged as Mock).mockReturnValue(() => {})
    ;(mockOnTagColorUpdated as Mock).mockReturnValue(() => {})
  })

  const renderView = async () => {
    const view = render(<TagDetailView tag="react" color="blue" />)
    // Wait for the initial load to finish
    await waitFor(() => expect(mockGetNotesByTag).toHaveBeenCalled())
    return view
  }

  const openOverflow = async (user: ReturnType<typeof userEvent.setup>) => {
    const trigger = screen.getByRole('button', { name: 'Tag actions' })
    await user.click(trigger)
  }

  describe('rename', () => {
    it('opens dialog prefilled with current tag name', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)

      await user.click(await screen.findByText('Edit tag name'))

      const input = await screen.findByLabelText('New name')
      expect(input).toHaveValue('react')
    })

    it('calls renameTag with trimmed new name and closes on success', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Edit tag name'))

      const input = await screen.findByLabelText('New name')
      await user.clear(input)
      await user.type(input, '  typescript  ')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() =>
        expect(mockRenameTag).toHaveBeenCalledWith({ oldName: 'react', newName: 'typescript' })
      )
      expect(mockToastSuccess).toHaveBeenCalledWith('Renamed #react to #typescript')
      expect(mockGoBack).toHaveBeenCalled()
    })

    it('refuses empty input', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Edit tag name'))

      const input = await screen.findByLabelText('New name')
      await user.clear(input)
      await user.click(screen.getByRole('button', { name: 'Save' }))

      expect(await screen.findByText('Tag name cannot be empty')).toBeInTheDocument()
      expect(mockRenameTag).not.toHaveBeenCalled()
    })

    it('toasts error and keeps dialog open on failure', async () => {
      mockRenameTag.mockResolvedValueOnce({ success: false, error: 'Tag already exists' })
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Edit tag name'))

      const input = await screen.findByLabelText('New name')
      await user.clear(input)
      await user.type(input, 'typescript')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Tag already exists'))
      expect(mockGoBack).not.toHaveBeenCalled()
      expect(await screen.findByLabelText('New name')).toBeInTheDocument()
    })
  })

  describe('delete', () => {
    it('calls deleteTag and navigates back on confirm', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)

      await user.click(await screen.findByText('Delete tag'))
      expect(await screen.findByText(/Delete tag #react\?/i)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Delete tag' }))

      await waitFor(() => expect(mockDeleteTag).toHaveBeenCalledWith('react'))
      expect(mockToastSuccess).toHaveBeenCalledWith('Deleted #react')
      expect(mockGoBack).toHaveBeenCalled()
    })

    it('toasts error when delete fails', async () => {
      mockDeleteTag.mockResolvedValueOnce({ success: false, error: 'Permission denied' })
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Delete tag'))
      await user.click(screen.getByRole('button', { name: 'Delete tag' }))

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Permission denied'))
      expect(mockGoBack).not.toHaveBeenCalled()
    })

    it('cancel closes dialog without calling deleteTag', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Delete tag'))

      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(mockDeleteTag).not.toHaveBeenCalled()
    })
  })

  describe('event subscriptions', () => {
    it('subscribes to onTagRenamed and onTagDeleted on mount', async () => {
      await renderView()
      expect(mockOnTagRenamed).toHaveBeenCalled()
      expect(mockOnTagDeleted).toHaveBeenCalled()
    })
  })
})
