/**
 * useNotes Hook Tests (T486-T489)
 * Tests for notes hooks: list, create, update, delete, tags, and links.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useNotes, useNoteTags, useNoteLinks, useNoteFolders } from './use-notes'
import {
  createTestQueryClient,
  createMockNote,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

// ============================================================================
// Test Setup
// ============================================================================

describe('useNotes', () => {
  let mockAPI: Record<string, unknown>
  let queryClient: QueryClient

  beforeEach(() => {
    mockAPI = setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  // ==========================================================================
  // T486: List Notes
  // ==========================================================================

  describe('list notes', () => {
    it('should load notes on mount when autoLoad is true', async () => {
      const mockNotes = [
        createMockNote({ id: 'note-1', title: 'Note 1' }),
        createMockNote({ id: 'note-2', title: 'Note 2' })
      ]

      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: mockNotes,
        total: 2,
        hasMore: false
      })

      const { result } = renderHook(() => useNotes({ autoLoad: true }), { wrapper })

      // Initially loading
      expect(result.current.isLoading).toBe(true)

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.notes).toHaveLength(2)
      expect(result.current.total).toBe(2)
      expect(result.current.hasMore).toBe(false)
      expect(window.api.notes.list).toHaveBeenCalled()
    })

    it('should not load notes on mount when autoLoad is false', async () => {
      const { result } = renderHook(() => useNotes({ autoLoad: false }), { wrapper })

      // Wait a tick to ensure no loading happens
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(result.current.notes).toHaveLength(0)
      expect(window.api.notes.list).not.toHaveBeenCalled()
    })

    it('should load notes with filters', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [createMockNote({ id: 'note-1', folder: 'projects' })],
        total: 1,
        hasMore: false
      })

      const { result } = renderHook(
        () => useNotes({ folder: 'projects', tags: ['important'], sortBy: 'title' }),
        { wrapper }
      )

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(window.api.notes.list).toHaveBeenCalledWith(
        expect.objectContaining({
          folder: 'projects',
          tags: ['important'],
          sortBy: 'title'
        })
      )
    })

    it('should load more notes when loadMore is called', async () => {
      const initialNotes = [createMockNote({ id: 'note-1' })]
      const moreNotes = [createMockNote({ id: 'note-2' })]

      ;(window.api.notes.list as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ notes: initialNotes, total: 2, hasMore: true })
        .mockResolvedValueOnce({ notes: moreNotes, total: 2, hasMore: false })

      const { result } = renderHook(() => useNotes({ limit: 1 }), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.hasMore).toBe(true)

      await act(async () => {
        await result.current.loadMore()
      })

      expect(result.current.notes).toHaveLength(2)
      expect(result.current.hasMore).toBe(false)
    })

    it('should handle list errors gracefully', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error')
      )

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBe('Network error')
      expect(result.current.notes).toHaveLength(0)
    })
  })

  // ==========================================================================
  // T487: Create Notes
  // ==========================================================================

  describe('create notes', () => {
    it('should create a note successfully', async () => {
      const newNote = createMockNote({ id: 'new-note', title: 'New Note' })

      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        note: newNote
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let createdNote: unknown
      await act(async () => {
        createdNote = await result.current.createNote({
          title: 'New Note',
          content: 'Test content',
          folder: 'notes'
        })
      })

      expect(createdNote).toEqual(newNote)
      expect(window.api.notes.create).toHaveBeenCalledWith({
        title: 'New Note',
        content: 'Test content',
        folder: 'notes'
      })
    })

    it('should handle create errors', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Title already exists'
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let createdNote: unknown
      await act(async () => {
        createdNote = await result.current.createNote({ title: 'Duplicate Title' })
      })

      expect(createdNote).toBeNull()
      expect(result.current.error).toBe('Title already exists')
    })

    it('should create note with template', async () => {
      const newNote = createMockNote({ id: 'templated-note' })

      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        note: newNote
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.createNote({
          title: 'From Template',
          template: 'meeting-notes'
        })
      })

      expect(window.api.notes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'meeting-notes'
        })
      )
    })
  })

  // ==========================================================================
  // T488: Update Notes
  // ==========================================================================

  describe('update notes', () => {
    it('should update a note successfully', async () => {
      const originalNote = createMockNote({ id: 'note-1', title: 'Original' })
      const updatedNote = createMockNote({ id: 'note-1', title: 'Updated' })

      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [originalNote],
        total: 1,
        hasMore: false
      })
      ;(window.api.notes.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        note: updatedNote
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let updated: unknown
      await act(async () => {
        updated = await result.current.updateNote({
          id: 'note-1',
          title: 'Updated',
          content: 'New content'
        })
      })

      expect(updated).toEqual(updatedNote)
      expect(window.api.notes.update).toHaveBeenCalledWith({
        id: 'note-1',
        title: 'Updated',
        content: 'New content'
      })
    })

    it('should update note tags', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        note: createMockNote({ id: 'note-1', tags: ['new-tag'] })
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.updateNote({
          id: 'note-1',
          tags: ['new-tag']
        })
      })

      expect(window.api.notes.update).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['new-tag']
        })
      )
    })

    it('should update note emoji', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        note: createMockNote({ id: 'note-1' })
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.updateNote({
          id: 'note-1',
          emoji: '📝'
        })
      })

      expect(window.api.notes.update).toHaveBeenCalledWith(
        expect.objectContaining({
          emoji: '📝'
        })
      )
    })

    it('should rename a note', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.rename as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        note: createMockNote({ id: 'note-1', title: 'Renamed' })
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.renameNote('note-1', 'Renamed')
      })

      expect(window.api.notes.rename).toHaveBeenCalledWith('note-1', 'Renamed')
    })

    it('should move a note to a different folder', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.move as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        note: createMockNote({ id: 'note-1', folder: 'archive' })
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.moveNote('note-1', 'archive')
      })

      expect(window.api.notes.move).toHaveBeenCalledWith('note-1', 'archive')
    })

    it('should handle update errors', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Note not found'
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const updated = await act(async () => {
        return await result.current.updateNote({ id: 'nonexistent' })
      })

      expect(updated).toBeNull()
      expect(result.current.error).toBe('Note not found')
    })
  })

  // ==========================================================================
  // T489: Delete Notes
  // ==========================================================================

  describe('delete notes', () => {
    it('should delete a note successfully', async () => {
      const note = createMockNote({ id: 'note-1' })

      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [note],
        total: 1,
        hasMore: false
      })
      ;(window.api.notes.delete as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let deleted: boolean = false
      await act(async () => {
        deleted = await result.current.deleteNote('note-1')
      })

      expect(deleted).toBe(true)
      expect(window.api.notes.delete).toHaveBeenCalledWith('note-1')
    })

    it('should handle delete errors', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.delete as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Permission denied'
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let deleted: boolean = true
      await act(async () => {
        deleted = await result.current.deleteNote('note-1')
      })

      expect(deleted).toBe(false)
      expect(result.current.error).toBe('Permission denied')
    })

    it('should clear current note when deleting the current note', async () => {
      const note = createMockNote({ id: 'note-1' })

      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [note],
        total: 1,
        hasMore: false
      })
      ;(window.api.notes.delete as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Set current note
      act(() => {
        result.current.setCurrentNote(note as unknown as Parameters<typeof result.current.setCurrentNote>[0])
      })

      expect(result.current.currentNote).toBeTruthy()

      // Delete the current note
      await act(async () => {
        await result.current.deleteNote('note-1')
      })

      expect(result.current.currentNote).toBeNull()
    })
  })

  // ==========================================================================
  // Utility Functions
  // ==========================================================================

  describe('utility functions', () => {
    it('should get a single note by id', async () => {
      const note = createMockNote({ id: 'note-1' })

      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes: [],
        total: 0,
        hasMore: false
      })
      ;(window.api.notes.get as ReturnType<typeof vi.fn>).mockResolvedValue(note)

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let fetchedNote: unknown
      await act(async () => {
        fetchedNote = await result.current.getNote('note-1')
      })

      expect(fetchedNote).toEqual(note)
      expect(window.api.notes.get).toHaveBeenCalledWith('note-1')
    })

    it('should clear error state', async () => {
      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Test error'))

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.error).toBe('Test error')
      })

      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBeNull()
    })

    it('should refresh the notes list', async () => {
      const notes = [createMockNote({ id: 'note-1' })]

      ;(window.api.notes.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        notes,
        total: 1,
        hasMore: false
      })

      const { result } = renderHook(() => useNotes(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(window.api.notes.list).toHaveBeenCalledTimes(1)

      await act(async () => {
        await result.current.refresh()
      })

      expect(window.api.notes.list).toHaveBeenCalledTimes(2)
    })
  })
})

// ============================================================================
// useNoteTags Tests
// ============================================================================

describe('useNoteTags', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load tags on mount', async () => {
    const mockTags = [
      { tag: 'important', color: '#ff0000', count: 5 },
      { tag: 'work', color: '#00ff00', count: 3 }
    ]

    ;(window.api.notes.getTags as ReturnType<typeof vi.fn>).mockResolvedValue(mockTags)

    const { result } = renderHook(() => useNoteTags(), { wrapper })

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.tags).toEqual(mockTags)
    expect(result.current.error).toBeNull()
  })

  it('should handle empty vault gracefully', async () => {
    ;(window.api.notes.getTags as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Vault not initialized')
    )

    const { result } = renderHook(() => useNoteTags(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // Should not set error for "not initialized"
    expect(result.current.tags).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('should handle real errors', async () => {
    ;(window.api.notes.getTags as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database error')
    )

    const { result } = renderHook(() => useNoteTags(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('Database error')
  })

  it('should refresh tags', async () => {
    const mockTags = [{ tag: 'test', color: '#000000', count: 1 }]

    ;(window.api.notes.getTags as ReturnType<typeof vi.fn>).mockResolvedValue(mockTags)

    const { result } = renderHook(() => useNoteTags(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(window.api.notes.getTags).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh()
    })

    expect(window.api.notes.getTags).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// useNoteLinks Tests
// ============================================================================

describe('useNoteLinks', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load links for a note', async () => {
    const mockLinks = {
      outgoing: [{ id: 'note-2', title: 'Linked Note' }],
      incoming: [{ id: 'note-3', title: 'Backlink' }]
    }

    ;(window.api.notes.getLinks as ReturnType<typeof vi.fn>).mockResolvedValue(mockLinks)

    const { result } = renderHook(() => useNoteLinks('note-1'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.outgoing).toEqual(mockLinks.outgoing)
    expect(result.current.incoming).toEqual(mockLinks.incoming)
    expect(window.api.notes.getLinks).toHaveBeenCalledWith('note-1')
  })

  it('should return empty arrays when noteId is null', async () => {
    const { result } = renderHook(() => useNoteLinks(null), { wrapper })

    // Should not be loading when noteId is null
    expect(result.current.outgoing).toEqual([])
    expect(result.current.incoming).toEqual([])
    expect(window.api.notes.getLinks).not.toHaveBeenCalled()
  })

  it('should handle link loading errors', async () => {
    ;(window.api.notes.getLinks as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to load links')
    )

    const { result } = renderHook(() => useNoteLinks('note-1'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('Failed to load links')
    expect(result.current.outgoing).toEqual([])
    expect(result.current.incoming).toEqual([])
  })

  it('should refresh links', async () => {
    const mockLinks = { outgoing: [], incoming: [] }

    ;(window.api.notes.getLinks as ReturnType<typeof vi.fn>).mockResolvedValue(mockLinks)

    const { result } = renderHook(() => useNoteLinks('note-1'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(window.api.notes.getLinks).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh?.()
    })

    expect(window.api.notes.getLinks).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// useNoteFolders Tests
// ============================================================================

describe('useNoteFolders', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load folders on mount', async () => {
    const mockFolders = ['notes', 'projects', 'archive']

    ;(window.api.notes.getFolders as ReturnType<typeof vi.fn>).mockResolvedValue(mockFolders)

    const { result } = renderHook(() => useNoteFolders(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.folders).toEqual(mockFolders)
  })

  it('should create a new folder', async () => {
    ;(window.api.notes.getFolders as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(window.api.notes.createFolder as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useNoteFolders(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    let success: boolean = false
    await act(async () => {
      success = await result.current.createFolder('new-folder')
    })

    expect(success).toBe(true)
    expect(window.api.notes.createFolder).toHaveBeenCalledWith('new-folder')
  })

  it('should handle folder creation errors', async () => {
    ;(window.api.notes.getFolders as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(window.api.notes.createFolder as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false })

    const { result } = renderHook(() => useNoteFolders(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    let success: boolean = true
    await act(async () => {
      success = await result.current.createFolder('invalid/folder')
    })

    expect(success).toBe(false)
  })

  it('should handle folder loading errors', async () => {
    ;(window.api.notes.getFolders as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to load folders')
    )

    const { result } = renderHook(() => useNoteFolders(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('Failed to load folders')
    expect(result.current.folders).toEqual([])
  })
})
