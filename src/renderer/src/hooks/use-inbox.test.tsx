/**
 * useInbox Hook Tests (T497-T499)
 *
 * Tests for inbox hooks: useInboxList, useCapture*, useFileItem, useSnoozeItem
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useInboxList,
  useInboxItem,
  useInboxStats,
  useCaptureText,
  useCaptureLink,
  useArchiveInboxItem,
  useFileInboxItem,
  useSnoozeInboxItem,
  useUnsnoozeInboxItem,
  useInboxOperations
} from './use-inbox'
import {
  createTestQueryClient,
  createMockInboxItem,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

// ============================================================================
// Test Setup
// ============================================================================

describe('useInboxList', () => {
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

  // ==========================================================================
  // T497: useInboxList - load and filter items
  // ==========================================================================

  describe('T497: load and filter items', () => {
    it('should load inbox items', async () => {
      const mockItems = [
        createMockInboxItem({ id: 'item-1', title: 'Item 1' }),
        createMockInboxItem({ id: 'item-2', title: 'Item 2' })
      ]

      ;(window.api.inbox.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: mockItems,
        total: 2,
        hasMore: false
      })

      const { result } = renderHook(() => useInboxList(), { wrapper })

      expect(result.current.isLoading).toBe(true)

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.items).toHaveLength(2)
      expect(result.current.total).toBe(2)
      expect(result.current.hasMore).toBe(false)
    })

    it('should filter by type', async () => {
      ;(window.api.inbox.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [createMockInboxItem({ type: 'link' })],
        total: 1,
        hasMore: false
      })

      const { result } = renderHook(() => useInboxList({ type: 'link' }), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(window.api.inbox.list).toHaveBeenCalledWith(expect.objectContaining({ type: 'link' }))
    })

    it('should support infinite scroll (loadMore)', async () => {
      const firstPage = [createMockInboxItem({ id: 'item-1' })]
      const secondPage = [createMockInboxItem({ id: 'item-2' })]

      ;(window.api.inbox.list as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ items: firstPage, total: 2, hasMore: true })
        .mockResolvedValueOnce({ items: secondPage, total: 2, hasMore: false })

      const { result } = renderHook(() => useInboxList({ limit: 1 }), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.hasMore).toBe(true)

      act(() => {
        result.current.loadMore()
      })

      await waitFor(() => {
        expect(result.current.items).toHaveLength(2)
      })

      expect(result.current.hasMore).toBe(false)
    })

    it('should handle load errors', async () => {
      ;(window.api.inbox.list as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Failed to load inbox')
      )

      const { result } = renderHook(() => useInboxList(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBeTruthy()
      expect(result.current.items).toEqual([])
    })

    it('should refetch items', async () => {
      ;(window.api.inbox.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [],
        total: 0,
        hasMore: false
      })

      const { result } = renderHook(() => useInboxList(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(window.api.inbox.list).toHaveBeenCalledTimes(1)

      act(() => {
        result.current.refetch()
      })

      await waitFor(() => {
        expect(window.api.inbox.list).toHaveBeenCalledTimes(2)
      })
    })
  })
})

// ============================================================================
// useInboxItem Tests
// ============================================================================

describe('useInboxItem', () => {
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

  it('should load a single inbox item', async () => {
    const mockItem = createMockInboxItem({ id: 'item-1', title: 'Test Item' })

    ;(window.api.inbox.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockItem)

    const { result } = renderHook(() => useInboxItem('item-1'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.item).toEqual(mockItem)
    expect(window.api.inbox.get).toHaveBeenCalledWith('item-1')
  })

  it('should not fetch when id is null', async () => {
    const { result } = renderHook(() => useInboxItem(null), { wrapper })

    // Wait a tick
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(window.api.inbox.get).not.toHaveBeenCalled()
    expect(result.current.item).toBeNull()
  })
})

// ============================================================================
// useInboxStats Tests
// ============================================================================

describe('useInboxStats', () => {
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

  it('should load inbox stats', async () => {
    const mockStats = { total: 10, unread: 5, stale: 2 }

    ;(window.api.inbox.getStats as ReturnType<typeof vi.fn>).mockResolvedValue(mockStats)

    const { result } = renderHook(() => useInboxStats(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.stats).toEqual(mockStats)
  })
})

// ============================================================================
// T498: useCapture* Tests
// ============================================================================

describe('useCaptureText', () => {
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

  describe('T498: capture text', () => {
    it('should capture text content', async () => {
      ;(window.api.inbox.captureText as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        item: createMockInboxItem({ type: 'text', content: 'Captured text' })
      })

      const { result } = renderHook(() => useCaptureText(), { wrapper })

      await act(async () => {
        await result.current.mutateAsync({ content: 'Captured text' })
      })

      expect(window.api.inbox.captureText).toHaveBeenCalledWith({ content: 'Captured text' })
    })

    it('should handle capture errors', async () => {
      ;(window.api.inbox.captureText as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Capture failed')
      )

      const { result } = renderHook(() => useCaptureText(), { wrapper })

      await expect(
        act(async () => {
          await result.current.mutateAsync({ content: 'Will fail' })
        })
      ).rejects.toThrow('Capture failed')
    })
  })
})

describe('useCaptureLink', () => {
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

  describe('T498: capture link', () => {
    it('should capture a link', async () => {
      ;(window.api.inbox.captureLink as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        item: createMockInboxItem({ type: 'link', url: 'https://example.com' })
      })

      const { result } = renderHook(() => useCaptureLink(), { wrapper })

      await act(async () => {
        await result.current.mutateAsync({ url: 'https://example.com' })
      })

      expect(window.api.inbox.captureLink).toHaveBeenCalledWith({ url: 'https://example.com' })
    })
  })
})

// ============================================================================
// T499: useFileItem and useSnoozeItem Tests
// ============================================================================

describe('useFileInboxItem', () => {
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

  describe('T499: file item to folder', () => {
    it('should file an item to a folder', async () => {
      ;(window.api.inbox.file as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        noteId: 'note-123'
      })

      const { result } = renderHook(() => useFileInboxItem(), { wrapper })

      await act(async () => {
        await result.current.mutateAsync({ itemId: 'item-1', folder: 'projects' })
      })

      expect(window.api.inbox.file).toHaveBeenCalledWith({
        itemId: 'item-1',
        folder: 'projects'
      })
    })

    it('should handle filing errors', async () => {
      ;(window.api.inbox.file as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Filing failed')
      )

      const { result } = renderHook(() => useFileInboxItem(), { wrapper })

      await expect(
        act(async () => {
          await result.current.mutateAsync({ itemId: 'item-1', folder: 'projects' })
        })
      ).rejects.toThrow('Filing failed')
    })
  })
})

describe('useArchiveInboxItem', () => {
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

  it('should archive an item', async () => {
    ;(window.api.inbox.archive as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useArchiveInboxItem(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync('item-1')
    })

    expect(window.api.inbox.archive).toHaveBeenCalledWith('item-1')
  })
})

describe('useSnoozeInboxItem', () => {
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

  describe('T499: snooze item', () => {
    it('should snooze an item until a specific date', async () => {
      ;(window.api.inbox.snooze as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

      const { result } = renderHook(() => useSnoozeInboxItem(), { wrapper })

      const snoozedUntil = '2026-01-10T09:00:00Z'

      await act(async () => {
        await result.current.mutateAsync({ itemId: 'item-1', snoozedUntil })
      })

      expect(window.api.inbox.snooze).toHaveBeenCalledWith({ itemId: 'item-1', snoozedUntil })
    })
  })
})

describe('useUnsnoozeInboxItem', () => {
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

  describe('T499: unsnooze item', () => {
    it('should unsnooze an item', async () => {
      ;(window.api.inbox.unsnooze as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

      const { result } = renderHook(() => useUnsnoozeInboxItem(), { wrapper })

      await act(async () => {
        await result.current.mutateAsync('item-1')
      })

      expect(window.api.inbox.unsnooze).toHaveBeenCalledWith('item-1')
    })
  })
})

// ============================================================================
// useInboxOperations Tests
// ============================================================================

describe('useInboxOperations', () => {
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

  it('should provide all inbox operations', async () => {
    const { result } = renderHook(() => useInboxOperations(), { wrapper })

    // Check that all operations are available
    expect(result.current.captureText).toBeDefined()
    expect(result.current.captureLink).toBeDefined()
    expect(result.current.updateItem).toBeDefined()
    expect(result.current.archiveItem).toBeDefined()
    expect(result.current.fileItem).toBeDefined()
    expect(result.current.snoozeItem).toBeDefined()
    expect(result.current.unsnoozeItem).toBeDefined()
    expect(result.current.addTag).toBeDefined()
    expect(result.current.removeTag).toBeDefined()
    expect(result.current.bulkArchive).toBeDefined()
    expect(result.current.bulkTag).toBeDefined()
  })

  it('should capture text through operations hook', async () => {
    ;(window.api.inbox.captureText as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      item: createMockInboxItem()
    })

    const { result } = renderHook(() => useInboxOperations(), { wrapper })

    await act(async () => {
      await result.current.captureText({ content: 'Test' })
    })

    expect(window.api.inbox.captureText).toHaveBeenCalled()
  })

  it('should archive item through operations hook', async () => {
    ;(window.api.inbox.archive as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useInboxOperations(), { wrapper })

    await act(async () => {
      await result.current.archiveItem('item-1')
    })

    expect(window.api.inbox.archive).toHaveBeenCalledWith('item-1')
  })
})
