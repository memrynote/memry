import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Y from 'yjs'

const {
  mockNewProviderCtor,
  mockOldProviderCtor,
  mockConnect,
  mockDestroy,
  providerState
} = vi.hoisted(() => ({
  mockNewProviderCtor: vi.fn(),
  mockOldProviderCtor: vi.fn(),
  mockConnect: vi.fn(),
  mockDestroy: vi.fn(),
  providerState: { synced: true }
}))

vi.mock('@/lib/crdt/yjs-tauri-provider', () => ({
  YjsTauriProvider: mockNewProviderCtor
}))

vi.mock('./yjs-ipc-provider', () => ({
  YjsIpcProvider: mockOldProviderCtor
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { useYjsCollaboration } from './use-yjs-collaboration'

function createProviderMock() {
  return {
    connect: mockConnect,
    destroy: mockDestroy,
    get isSynced() {
      return providerState.synced
    }
  }
}

describe('useYjsCollaboration', () => {
  beforeEach(() => {
    providerState.synced = true
    mockConnect.mockResolvedValue(undefined)
    mockNewProviderCtor.mockImplementation(createProviderMock)
    mockOldProviderCtor.mockImplementation(createProviderMock)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates the Rust-backed Yjs Tauri provider for note documents', async () => {
    const { result, unmount } = renderHook(() =>
      useYjsCollaboration({ noteId: 'note-provider', enabled: true })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(mockNewProviderCtor).toHaveBeenCalledWith({
      noteId: 'note-provider',
      doc: expect.any(Object) as Y.Doc
    })
    expect(mockOldProviderCtor).not.toHaveBeenCalled()
    expect(result.current.fragment).not.toBeNull()

    unmount()
    expect(mockDestroy).toHaveBeenCalled()
  })
})
