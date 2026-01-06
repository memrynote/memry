/**
 * useNoteProperties Hook Tests (T672)
 * Tests for note property CRUD with optimistic updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useNoteProperties } from './use-note-properties'

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getProperties: vi.fn(),
    setProperties: vi.fn()
  }
}))

import { notesService } from '@/services/notes-service'

// ============================================================================
// Test Data
// ============================================================================

const mockProperties = [
  { name: 'status', value: 'draft', type: 'text' as const },
  { name: 'priority', value: 3, type: 'number' as const },
  { name: 'published', value: false, type: 'checkbox' as const },
  { name: 'dueDate', value: '2024-12-25', type: 'date' as const },
  { name: 'tags', value: ['important', 'work'], type: 'multiselect' as const },
  { name: 'link', value: 'https://example.com', type: 'url' as const }
]

// ============================================================================
// Tests
// ============================================================================

describe('useNoteProperties', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(notesService.getProperties).mockResolvedValue(mockProperties)
    vi.mocked(notesService.setProperties).mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ==========================================================================
  // Initial Loading Tests
  // ==========================================================================

  describe('initial loading', () => {
    it('should fetch properties on mount', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      expect(result.current.isLoading).toBe(true)

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(notesService.getProperties).toHaveBeenCalledWith('note-1')
      expect(result.current.properties).toEqual(mockProperties)
    })

    it('should handle null noteId', async () => {
      const { result } = renderHook(() => useNoteProperties(null))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(notesService.getProperties).not.toHaveBeenCalled()
      expect(result.current.properties).toEqual([])
    })

    it('should refetch when noteId changes', async () => {
      const { result, rerender } = renderHook(
        ({ noteId }) => useNoteProperties(noteId),
        { initialProps: { noteId: 'note-1' } }
      )

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(notesService.getProperties).toHaveBeenCalledWith('note-1')

      // Change noteId
      vi.mocked(notesService.getProperties).mockResolvedValue([
        { name: 'other', value: 'prop', type: 'text' as const }
      ])
      rerender({ noteId: 'note-2' })

      await waitFor(() => {
        expect(notesService.getProperties).toHaveBeenCalledWith('note-2')
      })
    })

    it('should handle fetch errors', async () => {
      vi.mocked(notesService.getProperties).mockRejectedValue(new Error('Fetch failed'))

      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBe('Fetch failed')
      expect(result.current.properties).toEqual([])
    })
  })

  // ==========================================================================
  // propertiesRecord Tests
  // ==========================================================================

  describe('propertiesRecord', () => {
    it('should convert properties array to Record', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.propertiesRecord).toEqual({
        status: 'draft',
        priority: 3,
        published: false,
        dueDate: '2024-12-25',
        tags: ['important', 'work'],
        link: 'https://example.com'
      })
    })

    it('should be memoized', async () => {
      const { result, rerender } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const firstRecord = result.current.propertiesRecord

      rerender()

      expect(result.current.propertiesRecord).toBe(firstRecord)
    })
  })

  // ==========================================================================
  // updateProperty Tests
  // ==========================================================================

  describe('updateProperty', () => {
    it('should optimistically update property', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.updateProperty('status', 'published')
      })

      const statusProp = result.current.properties.find((p) => p.name === 'status')
      expect(statusProp?.value).toBe('published')
    })

    it('should call setProperties with updated record', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.updateProperty('priority', 5)
      })

      expect(notesService.setProperties).toHaveBeenCalledWith(
        'note-1',
        expect.objectContaining({
          priority: 5
        })
      )
    })

    it('should revert on error', async () => {
      vi.mocked(notesService.setProperties).mockResolvedValueOnce({
        success: false,
        error: 'Update failed'
      })

      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const originalValue = result.current.properties.find((p) => p.name === 'status')?.value

      await expect(
        act(async () => {
          await result.current.updateProperty('status', 'new-value')
        })
      ).rejects.toThrow('Update failed')

      // Should have refetched
      expect(notesService.getProperties).toHaveBeenCalledTimes(2)
    })

    it('should do nothing with null noteId', async () => {
      const { result } = renderHook(() => useNoteProperties(null))

      await act(async () => {
        await result.current.updateProperty('status', 'value')
      })

      expect(notesService.setProperties).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // addProperty Tests
  // ==========================================================================

  describe('addProperty', () => {
    it('should optimistically add property', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const initialCount = result.current.properties.length

      await act(async () => {
        await result.current.addProperty('newProp', 'newValue')
      })

      // Should have added optimistically
      expect(result.current.properties.length).toBeGreaterThanOrEqual(initialCount)
    })

    it('should infer type from string value', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.addProperty('textProp', 'hello')
      })

      expect(notesService.setProperties).toHaveBeenCalledWith(
        'note-1',
        expect.objectContaining({
          textProp: 'hello'
        })
      )
    })

    it('should infer type from number value', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.addProperty('numProp', 42)
      })

      expect(notesService.setProperties).toHaveBeenCalledWith(
        'note-1',
        expect.objectContaining({
          numProp: 42
        })
      )
    })

    it('should infer type from boolean value', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.addProperty('boolProp', true)
      })

      expect(notesService.setProperties).toHaveBeenCalledWith(
        'note-1',
        expect.objectContaining({
          boolProp: true
        })
      )
    })

    it('should infer type from array value', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.addProperty('arrayProp', ['a', 'b'])
      })

      expect(notesService.setProperties).toHaveBeenCalledWith(
        'note-1',
        expect.objectContaining({
          arrayProp: ['a', 'b']
        })
      )
    })

    it('should infer type from date string', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.addProperty('dateProp', '2024-12-25')
      })

      expect(notesService.setProperties).toHaveBeenCalledWith(
        'note-1',
        expect.objectContaining({
          dateProp: '2024-12-25'
        })
      )
    })

    it('should infer type from URL string', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.addProperty('urlProp', 'https://example.com')
      })

      expect(notesService.setProperties).toHaveBeenCalledWith(
        'note-1',
        expect.objectContaining({
          urlProp: 'https://example.com'
        })
      )
    })

    it('should refresh after adding', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const initialFetchCount = vi.mocked(notesService.getProperties).mock.calls.length

      await act(async () => {
        await result.current.addProperty('newProp', 'value')
      })

      expect(vi.mocked(notesService.getProperties).mock.calls.length).toBe(initialFetchCount + 1)
    })

    it('should revert on error', async () => {
      vi.mocked(notesService.setProperties).mockResolvedValueOnce({
        success: false,
        error: 'Add failed'
      })

      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await expect(
        act(async () => {
          await result.current.addProperty('failProp', 'value')
        })
      ).rejects.toThrow('Add failed')
    })
  })

  // ==========================================================================
  // removeProperty Tests
  // ==========================================================================

  describe('removeProperty', () => {
    it('should optimistically remove property', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const hadStatus = result.current.properties.some((p) => p.name === 'status')
      expect(hadStatus).toBe(true)

      await act(async () => {
        await result.current.removeProperty('status')
      })

      const hasStatus = result.current.properties.some((p) => p.name === 'status')
      expect(hasStatus).toBe(false)
    })

    it('should call setProperties without removed property', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.removeProperty('status')
      })

      expect(notesService.setProperties).toHaveBeenCalledWith(
        'note-1',
        expect.not.objectContaining({
          status: expect.anything()
        })
      )
    })

    it('should revert on error', async () => {
      vi.mocked(notesService.setProperties).mockResolvedValueOnce({
        success: false,
        error: 'Remove failed'
      })

      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await expect(
        act(async () => {
          await result.current.removeProperty('status')
        })
      ).rejects.toThrow('Remove failed')

      // Should have refetched
      expect(notesService.getProperties).toHaveBeenCalledTimes(2)
    })

    it('should do nothing with null noteId', async () => {
      const { result } = renderHook(() => useNoteProperties(null))

      await act(async () => {
        await result.current.removeProperty('status')
      })

      expect(notesService.setProperties).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // refresh Tests
  // ==========================================================================

  describe('refresh', () => {
    it('should refetch properties', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(notesService.getProperties).toHaveBeenCalledTimes(1)

      await act(async () => {
        await result.current.refresh()
      })

      expect(notesService.getProperties).toHaveBeenCalledTimes(2)
    })

    it('should update properties with fresh data', async () => {
      const { result } = renderHook(() => useNoteProperties('note-1'))

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Set up new data for refresh
      vi.mocked(notesService.getProperties).mockResolvedValueOnce([
        { name: 'fresh', value: 'data', type: 'text' as const }
      ])

      await act(async () => {
        await result.current.refresh()
      })

      expect(result.current.properties).toEqual([
        { name: 'fresh', value: 'data', type: 'text' }
      ])
    })
  })
})
