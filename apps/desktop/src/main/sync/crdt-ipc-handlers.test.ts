import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { CRDT_CHANNELS } from '@memry/contracts/ipc-crdt'

// ============================================================================
// Mocks — keep minimal; these handlers route through getCrdtProvider() so we
// mock the provider itself rather than its heavy dependencies (y-leveldb, fs,
// electron.app) to keep the test focused on handler lifecycle behaviour.
// ============================================================================

const senderWindow = vi.hoisted(() => ({
  current: { id: 1, once: vi.fn() } as { id: number; once: ReturnType<typeof vi.fn> }
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/crdt-test-userdata' },
  BrowserWindow: {
    fromWebContents: () => senderWindow.current,
    fromId: () => null,
    // resetCrdtProvider fans the rebind event out to every window, so the
    // teardown cases below reach broadcastToAllWindows.
    getAllWindows: () => []
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
vi.mock('../vault/frontmatter', () => ({
  parseNote: vi.fn(),
  serializeNote: vi.fn(),
  serializeParsedNote: vi.fn()
}))
vi.mock('./blocknote-converter', () => ({
  markdownToYFragment: vi.fn(),
  repairEmptyBlockIds: vi.fn(() => 0)
}))
vi.mock('./crdt-compact-utils', () => ({ compactYDoc: vi.fn() }))
vi.mock('./crdt-preflight', () => ({ runCrdtPreflight: vi.fn(async () => ({ ok: true })) }))
vi.mock('./crdt-writeback', () => ({
  scheduleWriteback: vi.fn(),
  cancelPendingWritebacks: vi.fn(),
  flushPendingWritebacks: vi.fn(),
  recordNetworkUpdate: vi.fn(),
  resetWritebackState: vi.fn()
}))
vi.mock('./microtask-batch-broadcaster', () => ({
  MicrotaskBatchBroadcaster: class {
    enqueue() {}
    flush() {}
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
    async flushDocument() {}
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
        update: new Uint8Array([1, 2, 3])
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
        diff: new Uint8Array([0, 0])
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
        stateVector: new Uint8Array([0])
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

  describe('window teardown releases the docs it pinned', () => {
    beforeEach(() => {
      senderWindow.current = { id: 42, once: vi.fn() }
      mockGetNoteCacheById.mockReturnValue({ id: 'n1', path: 'n1.md', fileType: 'markdown' })
    })

    it('releases every doc the window held once it is closed', async () => {
      // ⌘W / reload / renderer crash never runs the React cleanup that sends
      // crdt:close-doc, and BrowserWindow ids are never recycled — so without
      // this hook the id pins both docs for the rest of the session.
      const provider = getCrdtProvider()
      await provider.init()

      await invokeHandler(CRDT_CHANNELS.OPEN_DOC, { noteId: 'n1' })
      await invokeHandler(CRDT_CHANNELS.OPEN_DOC, { noteId: 'n2' })
      expect(provider.getOpenNoteIds().sort()).toEqual(['n1', 'n2'])

      // One 'closed' listener per window, not one per doc it opens.
      expect(senderWindow.current.once).toHaveBeenCalledTimes(1)
      expect(senderWindow.current.once).toHaveBeenCalledWith('closed', expect.any(Function))

      const onClosed = senderWindow.current.once.mock.calls[0][1] as () => void
      onClosed()

      await vi.waitFor(() => {
        expect(provider.getOpenNoteIds()).toEqual([])
      })
    })
  })

  describe('the sync handshake attributes the doc to the sender window', () => {
    const handshake = (noteId: string): Promise<unknown> =>
      invokeHandler(CRDT_CHANNELS.SYNC_STEP_1, { noteId, stateVector: new Uint8Array([0]) })

    beforeEach(() => {
      senderWindow.current = { id: 77, once: vi.fn() }
      mockGetNoteCacheById.mockReturnValue({ id: 'n1', path: 'n1.md', fileType: 'markdown' })
    })

    it('leaves a handshake-opened doc ineligible for eviction while it is in use', async () => {
      // crdt:open-doc can be skipped or fail, or a provider reset can drop the
      // entry — then the handshake is what creates the doc. Opened with no
      // windowId it had an empty windowIds set, so the doc the editor was about
      // to type into counted as inactive and was evictable mid-edit.
      const provider = getCrdtProvider()
      await provider.init()

      // #when — only the handshake runs, no crdt:open-doc
      await handshake('n1')

      // #then — closeIfInactive() is the exact primitive the eviction pass runs
      // per doc; it must refuse this one.
      await expect(provider.closeIfInactive('n1')).resolves.toBe(false)
      expect(provider.getOpenNoteIds({ active: true })).toEqual(['n1'])
    })

    it('keeps an edit that lands after an eviction pass instead of dropping it', async () => {
      // The eviction destroyed the entry, and applyIpcUpdate() returns early on
      // a missing entry — so the keystrokes were silently lost.
      const provider = getCrdtProvider()
      await provider.init()
      await handshake('n1')

      // #given — an eviction pass sweeps while the editor is still open
      await provider.closeIfInactive('n1')

      // #when — the renderer sends the next edit
      const source = new Y.Doc()
      source.getMap('probe').set('typed', 'after-eviction-pass')
      await invokeHandler(CRDT_CHANNELS.APPLY_UPDATE, {
        noteId: 'n1',
        update: Y.encodeStateAsUpdate(source)
      })

      // #then — the update reached the live doc
      expect(provider.getDoc('n1')?.getMap('probe').get('typed')).toBe('after-eviction-pass')
    })

    it('hooks the sender window once, not once per handshake', async () => {
      // Stacking a 'closed' listener per doc would trip Electron's
      // max-listeners warning on a window holding dozens of notes.
      const provider = getCrdtProvider()
      await provider.init()

      await handshake('n1')
      await handshake('n2')
      await handshake('n3')

      expect(senderWindow.current.once).toHaveBeenCalledTimes(1)
      expect(senderWindow.current.once).toHaveBeenCalledWith('closed', expect.any(Function))
    })

    it('releases the attribution when the window is destroyed', async () => {
      // The other half of the bug: an id that is never released pins the doc
      // for the session and disables eviction and compaction with it.
      const provider = getCrdtProvider()
      await provider.init()
      await handshake('n1')
      await handshake('n2')

      // #when — ⌘W / renderer crash: the window emits 'closed'
      const onClosed = senderWindow.current.once.mock.calls[0][1] as () => void
      onClosed()

      // #then — both docs released, so eviction and compaction see them again
      await vi.waitFor(() => {
        expect(provider.getOpenNoteIds()).toEqual([])
      })
    })

    it('releases the attribution on crdt:close-doc', async () => {
      // The renderer sends this on unmount, including the remount after a
      // window reload — the handshake-recorded id must clear the same way.
      const provider = getCrdtProvider()
      await provider.init()
      await handshake('n1')

      // #when
      await invokeHandler(CRDT_CHANNELS.CLOSE_DOC, { noteId: 'n1' })

      // #then
      expect(provider.getOpenNoteIds()).toEqual([])
    })

    it('releases the attribution when the vault closes', async () => {
      const provider = getCrdtProvider()
      await provider.init()
      await handshake('n1')

      // #when — vault close/switch tears the provider down
      await provider.destroy()

      // #then
      expect(provider.getOpenNoteIds()).toEqual([])
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
