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
type StateChangedPayload = { noteId: string; update: Uint8Array; origin: string }
type StateChangedCallback = (data: StateChangedPayload) => void

/**
 * Mirrors the preload registry (`preload/api/sync-ops.ts`): subscriptions are
 * note-scoped and a broadcast only reaches that note's subscribers. Testing the
 * provider against a global fan-out fake would hide a misrouted update.
 */
const noteSubscribers = new Map<string, Set<StateChangedCallback>>()
const mockOnCrdtStateChanged = vi.fn((noteId: string, callback: StateChangedCallback) => {
  const subscribers = noteSubscribers.get(noteId) ?? new Set<StateChangedCallback>()
  subscribers.add(callback)
  noteSubscribers.set(noteId, subscribers)
  return () => {
    subscribers.delete(callback)
    if (subscribers.size === 0) noteSubscribers.delete(noteId)
  }
})

function broadcastStateChanged(payload: StateChangedPayload): void {
  for (const callback of [...(noteSubscribers.get(payload.noteId) ?? [])]) callback(payload)
}

beforeEach(() => {
  mockOpenDoc.mockResolvedValue({ success: true })
  mockCloseDoc.mockResolvedValue({ success: true })
  mockSyncStep1.mockResolvedValue(null)
  mockSyncStep2.mockResolvedValue(undefined)
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
  noteSubscribers.clear()
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

describe('YjsIpcProvider.connect', () => {
  it('rejects when openDoc returns an unsuccessful result', async () => {
    mockOpenDoc.mockResolvedValueOnce({ success: false, error: 'Note not found' })
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-missing', doc })

    await expect(provider.connect()).rejects.toThrow('Note not found')
    expect(mockSyncStep1).not.toHaveBeenCalled()

    provider.destroy()
    doc.destroy()
  })

  it('opens the CRDT doc, applies remote state, and sends local sync state', async () => {
    const remoteDoc = new Y.Doc()
    remoteDoc.getMap('meta').set('title', 'Remote title')
    const emptyDoc = new Y.Doc()
    mockSyncStep1.mockResolvedValueOnce({
      diff: Y.encodeStateAsUpdate(remoteDoc),
      stateVector: Y.encodeStateVector(emptyDoc)
    })

    const doc = new Y.Doc()
    doc.getMap('local').set('draft', true)
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })

    await provider.connect()

    expect(mockOpenDoc).toHaveBeenCalledWith({ noteId: 'note-42' })
    expect(mockSyncStep1).toHaveBeenCalledWith({
      noteId: 'note-42',
      stateVector: expect.any(Uint8Array)
    })
    expect(doc.getMap('meta').get('title')).toBe('Remote title')
    expect(mockSyncStep2).toHaveBeenCalledWith({
      noteId: 'note-42',
      diff: expect.any(Uint8Array)
    })
    expect(provider.isSynced).toBe(true)

    provider.destroy()
    doc.destroy()
    emptyDoc.destroy()
    remoteDoc.destroy()
  })

  it('applies matching IPC updates and forwards local document updates', async () => {
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })

    await provider.connect()

    // The provider claims its own note, not the global channel.
    expect(mockOnCrdtStateChanged).toHaveBeenCalledWith('note-42', expect.any(Function))

    const otherDoc = new Y.Doc()
    otherDoc.getMap('meta').set('remote', true)
    broadcastStateChanged({
      noteId: 'other-note',
      update: Y.encodeStateAsUpdate(otherDoc),
      origin: 'remote'
    })
    expect(doc.getMap('meta').get('remote')).toBeUndefined()

    broadcastStateChanged({
      noteId: 'note-42',
      update: Y.encodeStateAsUpdate(otherDoc),
      origin: 'remote'
    })
    expect(doc.getMap('meta').get('remote')).toBe(true)

    mockApplyUpdate.mockClear()
    doc.getMap('meta').set('local', true)
    expect(mockApplyUpdate).toHaveBeenCalledWith({
      noteId: 'note-42',
      update: expect.any(Uint8Array)
    })

    mockApplyUpdate.mockClear()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(otherDoc), 'remote')
    expect(mockApplyUpdate).not.toHaveBeenCalled()

    provider.destroy()
    doc.destroy()
    otherDoc.destroy()
  })

  it('does not perform the handshake after being destroyed mid-connect', async () => {
    let resolveOpen: (value: { success: boolean }) => void = () => {}
    mockOpenDoc.mockReturnValueOnce(new Promise((resolve) => (resolveOpen = resolve)))
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })

    const connect = provider.connect()
    provider.destroy()
    resolveOpen({ success: true })
    await connect

    expect(mockSyncStep1).not.toHaveBeenCalled()

    doc.destroy()
  })
})

describe('YjsIpcProvider note-scoped subscription', () => {
  it('never wakes another note’s provider for an update it does not own', async () => {
    // #given — two notes open in the same window, the shape that used to make
    // every provider run for every keystroke in any note
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const providerA = new YjsIpcProvider({ noteId: 'note-a', doc: docA })
    const providerB = new YjsIpcProvider({ noteId: 'note-b', doc: docB })
    await providerA.connect()
    await providerB.connect()

    const sourceDoc = new Y.Doc()
    sourceDoc.getMap('meta').set('remote', true)

    // #when — an update lands for note A only
    broadcastStateChanged({
      noteId: 'note-a',
      update: Y.encodeStateAsUpdate(sourceDoc),
      origin: 'remote'
    })

    // #then — A applied it, B was not invoked at all and its doc is untouched
    expect(docA.getMap('meta').get('remote')).toBe(true)
    expect(docB.getMap('meta').get('remote')).toBeUndefined()
    expect(noteSubscribers.get('note-b')?.size).toBe(1)

    providerA.destroy()
    providerB.destroy()
    docA.destroy()
    docB.destroy()
    sourceDoc.destroy()
  })

  it('releases its subscription on destroy so repeated open/close stays bounded', async () => {
    // #given/#when — 50 open→close cycles of the same note
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const doc = new Y.Doc()
      const provider = new YjsIpcProvider({ noteId: 'note-cycled', doc })
      await provider.connect()
      expect(noteSubscribers.get('note-cycled')?.size).toBe(1)
      provider.destroy()
      doc.destroy()
    }

    // #then — nothing accumulates for a note that was opened and closed
    expect(noteSubscribers.has('note-cycled')).toBe(false)
  })

  it('stops applying updates for a note after the provider is destroyed', async () => {
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })
    await provider.connect()
    provider.destroy()

    const sourceDoc = new Y.Doc()
    sourceDoc.getMap('meta').set('remote', true)
    broadcastStateChanged({
      noteId: 'note-42',
      update: Y.encodeStateAsUpdate(sourceDoc),
      origin: 'remote'
    })

    expect(doc.getMap('meta').get('remote')).toBeUndefined()

    doc.destroy()
    sourceDoc.destroy()
  })
})

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
