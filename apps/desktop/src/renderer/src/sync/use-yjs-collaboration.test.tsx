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
    onCrdtStateChanged: mockOnCrdtStateChanged
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
