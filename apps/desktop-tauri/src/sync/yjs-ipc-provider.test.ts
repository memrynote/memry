import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

// ============================================================================
// Renderer-side mocks for window.api and logger
// ============================================================================

const mockCloseDoc = vi.fn()
const mockOpenDoc = vi.fn()
const mockApplyUpdate = vi.fn()
const mockSyncStep1 = vi.fn()
const mockSyncStep2 = vi.fn()
const mockOnCrdtStateChanged = vi.fn(() => () => {})

beforeEach(() => {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      syncCrdt: {
        openDoc: mockOpenDoc,
        closeDoc: mockCloseDoc,
        applyUpdate: mockApplyUpdate,
        syncStep1: mockSyncStep1,
        syncStep2: mockSyncStep2
      },
      onCrdtStateChanged: mockOnCrdtStateChanged
    }
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

// ============================================================================
// SUT
// ============================================================================

import { YjsIpcProvider } from './yjs-ipc-provider'

describe('YjsIpcProvider.disconnect', () => {
  it('swallows rejection from closeDoc (expected during teardown)', async () => {
    // #given — closeDoc rejects, mimicking stale-handler state right after logout
    mockCloseDoc.mockRejectedValueOnce(new Error("No handler registered for 'crdt:close-doc'"))
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })

    // #when — normal teardown path invoked by useEffect cleanup
    expect(() => provider.destroy()).not.toThrow()

    // Let the rejected promise microtask flush
    await Promise.resolve()
    await Promise.resolve()

    // #then — closeDoc was attempted exactly once; no unhandled rejection escapes
    expect(mockCloseDoc).toHaveBeenCalledTimes(1)
    expect(mockCloseDoc).toHaveBeenCalledWith({ noteId: 'note-42' })

    doc.destroy()
  })

  it('invokes closeDoc with correct noteId on disconnect', () => {
    // #given
    mockCloseDoc.mockResolvedValueOnce({ success: true })
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-7', doc })

    // #when
    provider.disconnect()

    // #then
    expect(mockCloseDoc).toHaveBeenCalledWith({ noteId: 'note-7' })
    expect(provider.isSynced).toBe(false)

    doc.destroy()
  })
})
