import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mockCloseDoc = vi.fn()
const mockOpenDoc = vi.fn()
const mockApplyUpdate = vi.fn()
const mockSyncStep1 = vi.fn()
const mockSyncStep2 = vi.fn()
const mockOnCrdtStateChanged = vi.fn(() => () => {})

beforeEach(() => {
  mockOpenDoc.mockResolvedValue({ success: true })
  mockCloseDoc.mockResolvedValue({ success: true })
  mockSyncStep1.mockResolvedValue(null)
  mockSyncStep2.mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown }).api = {
    syncCrdt: {
      openDoc: mockOpenDoc,
      closeDoc: mockCloseDoc,
      applyUpdate: mockApplyUpdate,
      syncStep1: mockSyncStep1,
      syncStep2: mockSyncStep2
    },
    onCrdtStateChanged: mockOnCrdtStateChanged,
    // Every provider subscribes to the rebind event on connect.
    onCrdtProviderReset: () => () => {}
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { useYjsCollaboration } from './use-yjs-collaboration'

describe('useYjsCollaboration', () => {
  it('stays disabled when note id is missing or collaboration is disabled', () => {
    const { result, rerender } = renderHook((props) => useYjsCollaboration(props), {
      initialProps: { noteId: undefined as string | undefined }
    })

    expect(result.current.isReady).toBe(false)
    expect(result.current.fragment).toBeNull()
    expect(result.current.provider).toBeNull()
    expect(mockOpenDoc).not.toHaveBeenCalled()

    rerender({ noteId: 'note-disabled', enabled: false })

    expect(result.current.isReady).toBe(false)
    expect(result.current.fragment).toBeNull()
    expect(result.current.provider).toBeNull()
    expect(mockOpenDoc).not.toHaveBeenCalled()
  })

  it('returns a synced fragment and cleans up when note id changes', async () => {
    const closeCleanup = vi.fn()
    mockOnCrdtStateChanged.mockReturnValueOnce(closeCleanup)
    const { result, rerender, unmount } = renderHook((props) => useYjsCollaboration(props), {
      initialProps: { noteId: 'note-1' as string | undefined }
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(result.current.fragment).not.toBeNull()
    expect(result.current.provider?.isSynced).toBe(true)
    expect(result.current.isRemoteUpdateRef.current).toBe(false)

    rerender({ noteId: 'note-2' })

    await waitFor(() => expect(mockCloseDoc).toHaveBeenCalledWith({ noteId: 'note-1' }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.provider?.noteId).toBe('note-2')

    unmount()
    expect(closeCleanup).toHaveBeenCalled()
  })

  it('fails open without a Yjs fragment when the CRDT doc cannot open', async () => {
    mockOpenDoc.mockResolvedValueOnce({ success: false, error: 'Note not found' })

    const { result, unmount } = renderHook(() => useYjsCollaboration({ noteId: 'note-missing' }))

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })

    expect(result.current.fragment).toBeNull()
    expect(result.current.provider).toBeNull()
    expect(mockSyncStep1).not.toHaveBeenCalled()

    unmount()
  })
})
