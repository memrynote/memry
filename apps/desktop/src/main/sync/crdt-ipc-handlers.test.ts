import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { CRDT_CHANNELS } from '@memry/contracts/ipc-crdt'

// ============================================================================
// Mocks — keep minimal; these handlers route through getCrdtProvider() so we
// mock the provider itself rather than its heavy dependencies (y-leveldb, fs,
// electron.app) to keep the test focused on handler lifecycle behaviour.
// ============================================================================

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/crdt-test-userdata' },
  BrowserWindow: {
    fromWebContents: () => ({ id: 1 }),
    fromId: () => null
  },
  ipcMain: mockIpcMain
}))

const mockGetNoteCacheById = vi.fn()
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (...args: unknown[]) => mockGetNoteCacheById(...args)
}))

vi.mock('../database/client', () => ({
  getIndexDatabase: () => ({})
}))

vi.mock('../vault/notes', () => ({ toAbsolutePath: vi.fn() }))
vi.mock('../vault/file-ops', () => ({ safeRead: vi.fn() }))
vi.mock('../vault/frontmatter', () => ({ parseNote: vi.fn() }))
vi.mock('./blocknote-converter', () => ({ markdownToYFragment: vi.fn() }))
vi.mock('./crdt-compact-utils', () => ({ compactYDoc: vi.fn() }))
vi.mock('./crdt-writeback', () => ({
  scheduleWriteback: vi.fn(),
  cancelPendingWritebacks: vi.fn(),
  recordNetworkUpdate: vi.fn()
}))
vi.mock('./microtask-batch-broadcaster', () => ({
  MicrotaskBatchBroadcaster: class {
    flushAll() {}
    schedule() {}
  }
}))

vi.mock('y-leveldb', () => ({
  LeveldbPersistence: class {
    async destroy() {}
    async getYDoc() {
      const Y = await import('yjs')
      return new Y.Doc()
    }
    async storeUpdate() {}
    async clearDocument() {}
  }
}))

// ============================================================================
// SUT: import AFTER mocks are in place
// ============================================================================

import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { _resetCrdtIpcHandlersForTests, registerCrdtIpcHandlers } from '../ipc/crdt-handlers'

describe('CRDT IPC handlers — lifecycle resilience', () => {
  beforeEach(() => {
    resetIpcMocks()
    mockIpcMain._clearHandlers()
    resetCrdtProvider()
    _resetCrdtIpcHandlersForTests()
    mockGetNoteCacheById.mockReset()
    registerCrdtIpcHandlers()
  })

  afterEach(() => {
    resetCrdtProvider()
  })

  describe('channel registration', () => {
    it('registers all five CRDT channels on ipcMain', () => {
      // #then — handlers are registered for every CRDT channel
      expect(mockIpcMain._getHandler(CRDT_CHANNELS.OPEN_DOC)).toBeDefined()
      expect(mockIpcMain._getHandler(CRDT_CHANNELS.CLOSE_DOC)).toBeDefined()
      expect(mockIpcMain._getHandler(CRDT_CHANNELS.APPLY_UPDATE)).toBeDefined()
      expect(mockIpcMain._getHandler(CRDT_CHANNELS.SYNC_STEP_1)).toBeDefined()
      expect(mockIpcMain._getHandler(CRDT_CHANNELS.SYNC_STEP_2)).toBeDefined()
    })

    it('is idempotent: a second call does not re-register', () => {
      // #given — already registered in beforeEach
      const firstHandler = mockIpcMain._getHandler(CRDT_CHANNELS.CLOSE_DOC)

      // #when
      registerCrdtIpcHandlers()

      // #then — same handler reference, ipcMain.handle was not called again
      expect(mockIpcMain._getHandler(CRDT_CHANNELS.CLOSE_DOC)).toBe(firstHandler)
    })
  })

  describe('post-teardown behaviour (the signout bug)', () => {
    it('crdt:close-doc returns success after destroy() + resetCrdtProvider()', async () => {
      // #given — the exact teardown sequence that happens on logout
      await getCrdtProvider().destroy()
      resetCrdtProvider()

      // #when — renderer cleanup fires a late closeDoc after teardown
      const result = await invokeHandler(CRDT_CHANNELS.CLOSE_DOC, {
        noteId: 'note-that-was-open'
      })

      // #then — no throw, graceful success response
      expect(result).toEqual({ success: true })
    })

    it('crdt:close-doc does NOT remove its own handler after destroy()', async () => {
      // #when — provider torn down
      await getCrdtProvider().destroy()
      resetCrdtProvider()

      // #then — handler is still registered; ipcMain.removeHandler was never called for CRDT channels
      expect(mockIpcMain._getHandler(CRDT_CHANNELS.CLOSE_DOC)).toBeDefined()
      const removed = mockIpcMain.removeHandler.mock.calls.map((c) => c[0])
      expect(removed).not.toContain(CRDT_CHANNELS.CLOSE_DOC)
      expect(removed).not.toContain(CRDT_CHANNELS.OPEN_DOC)
      expect(removed).not.toContain(CRDT_CHANNELS.APPLY_UPDATE)
      expect(removed).not.toContain(CRDT_CHANNELS.SYNC_STEP_1)
      expect(removed).not.toContain(CRDT_CHANNELS.SYNC_STEP_2)
    })

    it('crdt:apply-update silently no-ops for unknown note after teardown', async () => {
      // #given
      await getCrdtProvider().destroy()
      resetCrdtProvider()

      // #when — late renderer update arrives post-logout
      const result = await invokeHandler(CRDT_CHANNELS.APPLY_UPDATE, {
        noteId: 'ghost-note',
        update: [1, 2, 3]
      })

      // #then — void return, no throw
      expect(result).toBeUndefined()
    })

    it('crdt:sync-step-2 silently no-ops for unknown note after teardown', async () => {
      // #given
      await getCrdtProvider().destroy()
      resetCrdtProvider()

      // #when
      const result = await invokeHandler(CRDT_CHANNELS.SYNC_STEP_2, {
        noteId: 'ghost-note',
        diff: [0, 0]
      })

      // #then
      expect(result).toBeUndefined()
    })

    it('crdt:sync-step-1 returns null when provider is uninitialized', async () => {
      // #given — fresh provider, never init'd
      // (beforeEach already reset; getCrdtProvider() returns new uninitialised instance)

      // #when
      const result = await invokeHandler(CRDT_CHANNELS.SYNC_STEP_1, {
        noteId: 'any-note',
        stateVector: [0]
      })

      // #then — handler guards and returns null rather than throwing
      expect(result).toBeNull()
    })

    it('crdt:open-doc returns error (not throw) when provider is uninitialized', async () => {
      // #given — provider not init'd
      mockGetNoteCacheById.mockReturnValue({ noteId: 'n1', fileType: 'markdown' })

      // #when
      const result = await invokeHandler<{ success: boolean; error?: string }>(
        CRDT_CHANNELS.OPEN_DOC,
        { noteId: 'n1' }
      )

      // #then
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/not initialized/i)
    })
  })

  describe('handlers survive provider reset (fresh instance)', () => {
    it('close-doc still works after getCrdtProvider() returns a new instance', async () => {
      // #given — simulate logout (destroy + reset)
      await getCrdtProvider().destroy()
      resetCrdtProvider()
      // Simulate a subsequent new provider being created lazily
      const newProvider = getCrdtProvider()
      expect(newProvider.isInitialized()).toBe(false)

      // #when — old renderer cleanup fires AFTER teardown, before any re-init
      const result = await invokeHandler(CRDT_CHANNELS.CLOSE_DOC, {
        noteId: 'some-note'
      })

      // #then — routes into new provider, no-ops safely (docs is empty)
      expect(result).toEqual({ success: true })
    })
  })
})
