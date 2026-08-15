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

/**
 * The provider-reset channel carries no note id: main dropped the instance that
 * owned every doc at once, so every provider in the window hears it.
 */
const resetSubscribers = new Set<() => void>()
const mockOnCrdtProviderReset = vi.fn((callback: () => void) => {
  resetSubscribers.add(callback)
  return () => resetSubscribers.delete(callback)
})

function broadcastProviderReset(): void {
  for (const callback of [...resetSubscribers]) callback()
}

/**
 * The counterpart signal: a provider in main finished initializing and will
 * serve `crdt:open-doc` again. Also note-less — one provider serves every doc.
 */
const readySubscribers = new Set<() => void>()
const mockOnCrdtProviderReady = vi.fn((callback: () => void) => {
  readySubscribers.add(callback)
  return () => readySubscribers.delete(callback)
})

function broadcastProviderReady(): void {
  for (const callback of [...readySubscribers]) callback()
}

/**
 * What main actually returns while the provider that owned this doc is being
 * torn down and no replacement has been initialized — `crdt-handlers.ts` gates
 * OPEN_DOC on `provider.isInitialized()`. Every rebind attempt made from the
 * reset event itself got this, on every device, every time.
 */
const TEARDOWN_OPEN_DOC_RESULT = {
  success: false,
  error: 'CRDT provider not initialized'
} as const

/**
 * Drain the promise chain a rebind runs on. Deterministic and fake-timer safe,
 * which `vi.waitFor` is not — and these tests assert on `vi.getTimerCount()`,
 * so a helper that itself schedules timers would be measuring itself.
 */
async function flushMicrotasks(cycles = 25): Promise<void> {
  for (let i = 0; i < cycles; i += 1) await Promise.resolve()
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
      onCrdtStateChanged: mockOnCrdtStateChanged,
      onCrdtProviderReset: mockOnCrdtProviderReset,
      onCrdtProviderReady: mockOnCrdtProviderReady
    }
  }
})

afterEach(() => {
  vi.clearAllMocks()
  noteSubscribers.clear()
  resetSubscribers.clear()
  readySubscribers.clear()
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

describe('YjsIpcProvider provider reset', () => {
  it('does not re-open into the provider that is being torn down', async () => {
    // #given a connected editor, and main mid-teardown: the provider that owned
    // this doc is destroyed and no replacement is initialized, so OPEN_DOC is
    // rejected outright
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })
    await provider.connect()
    mockOpenDoc.mockClear()
    mockSyncStep1.mockClear()
    mockOpenDoc.mockResolvedValue(TEARDOWN_OPEN_DOC_RESULT)

    // #when the reset lands — which is exactly when teardown broadcasts it
    broadcastProviderReset()
    await Promise.resolve()
    await Promise.resolve()

    // #then no doomed IPC. Answering the reset by re-opening failed 100% of the
    // time in the real app: `rebind()` caught, logged and dropped, so the editor
    // stayed unbound forever and a remote edit only appeared after a close and
    // reopen. The reset only records the death.
    expect(mockOpenDoc).not.toHaveBeenCalled()
    expect(mockSyncStep1).not.toHaveBeenCalled()

    // #and the binding must stop claiming to be live, while the doc stays
    // editable — those edits exist only in this window.
    expect(provider.isSynced).toBe(false)
    expect(doc.isDestroyed).toBe(false)
    doc.getMap('meta').set('title', 'Still typeable')
    expect(doc.getMap('meta').get('title')).toBe('Still typeable')

    provider.destroy()
    doc.destroy()
  })

  it('rebinds when a provider becomes ready, carrying edits made while unbound', async () => {
    // #given the full real sequence: connected editor → reset during teardown →
    // the user keeps typing → a provider in main finishes initializing
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })
    await provider.connect()

    mockOpenDoc.mockResolvedValue(TEARDOWN_OPEN_DOC_RESULT)
    broadcastProviderReset()
    await Promise.resolve()

    doc.getMap('meta').set('title', 'Typed while unbound')
    mockOpenDoc.mockClear()
    mockSyncStep1.mockClear()
    mockSyncStep2.mockClear()
    mockOpenDoc.mockResolvedValue({ success: true })

    const rebuiltDoc = new Y.Doc()
    mockSyncStep1.mockResolvedValueOnce({
      diff: Y.encodeStateAsUpdate(rebuiltDoc),
      stateVector: Y.encodeStateVector(rebuiltDoc)
    })

    // #when
    broadcastProviderReady()
    await vi.waitFor(() => expect(mockSyncStep2).toHaveBeenCalled())

    // #then re-opening is what re-attributes this window to the fresh doc; without
    // it main broadcasts to a window set the editor is not in and the note goes
    // stale with no further signal. The local doc is merged, not replaced, so the
    // edit made while unbound is pushed to main instead of being dropped.
    expect(mockOpenDoc).toHaveBeenCalledWith({ noteId: 'note-42' })
    expect(mockSyncStep1).toHaveBeenCalledWith({
      noteId: 'note-42',
      stateVector: expect.any(Uint8Array)
    })
    expect(mockSyncStep2).toHaveBeenCalledWith({
      noteId: 'note-42',
      diff: expect.any(Uint8Array)
    })
    expect(doc.getMap('meta').get('title')).toBe('Typed while unbound')
    expect(provider.isSynced).toBe(true)

    provider.destroy()
    doc.destroy()
    rebuiltDoc.destroy()
  })

  it('retries a failed rebind on the next ready rather than on a timer', async () => {
    vi.useFakeTimers()
    try {
      const doc = new Y.Doc()
      const provider = new YjsIpcProvider({ noteId: 'note-42', doc })
      await provider.connect()

      mockOpenDoc.mockResolvedValue(TEARDOWN_OPEN_DOC_RESULT)
      broadcastProviderReset()
      await Promise.resolve()

      // #when a provider comes up but this note cannot be served yet (the vault
      // index has not caught up, so validateNoteForCrdt fails)
      mockOpenDoc.mockClear()
      mockOpenDoc.mockResolvedValue({ success: false, error: 'Note not found: note-42' })
      broadcastProviderReady()
      await flushMicrotasks()

      // #then the binding is still stale and nothing is scheduled — a blind
      // retry loop is not the mechanism, and must not be left running
      expect(mockOpenDoc).toHaveBeenCalledTimes(1)
      expect(provider.isSynced).toBe(false)
      expect(vi.getTimerCount()).toBe(0)

      // #when the next provider comes up
      mockOpenDoc.mockClear()
      mockOpenDoc.mockResolvedValue({ success: true })
      broadcastProviderReady()
      await flushMicrotasks()

      // #then the retry rode the real signal, not a poll
      expect(provider.isSynced).toBe(true)
      expect(mockOpenDoc).toHaveBeenCalledWith({ noteId: 'note-42' })
      expect(vi.getTimerCount()).toBe(0)

      provider.destroy()
      doc.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rebinds once for two resets in a row and does not re-handshake a live binding', async () => {
    // #given sign-out resets the provider twice (stopSyncRuntime, then again
    // after wipeStorage), and the sync runtime that follows can announce more
    // than one ready
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })
    await provider.connect()

    mockOpenDoc.mockResolvedValue(TEARDOWN_OPEN_DOC_RESULT)
    broadcastProviderReset()
    broadcastProviderReset()
    await Promise.resolve()

    mockOpenDoc.mockClear()
    mockOpenDoc.mockResolvedValue({ success: true })

    // #when
    broadcastProviderReady()
    broadcastProviderReady()
    await vi.waitFor(() => expect(provider.isSynced).toBe(true))
    await Promise.resolve()
    await Promise.resolve()

    // #then exactly one re-open. A second handshake against a binding that is
    // already live is not free — it round-trips the whole doc — and two of them
    // interleaved would race each other's state vectors.
    expect(mockOpenDoc).toHaveBeenCalledTimes(1)
    // #and one subscription each, however many resets went by
    expect(resetSubscribers.size).toBe(1)
    expect(readySubscribers.size).toBe(1)

    provider.destroy()
    doc.destroy()
  })

  it('leaves nothing behind when a reset is never followed by a ready', async () => {
    // #given the signed-out steady state: main resets the provider and never
    // brings one up again, because collaboration is off without a session
    vi.useFakeTimers()
    try {
      const doc = new Y.Doc()
      const provider = new YjsIpcProvider({ noteId: 'note-42', doc })
      await provider.connect()

      mockOpenDoc.mockClear()
      mockOpenDoc.mockResolvedValue(TEARDOWN_OPEN_DOC_RESULT)
      for (let i = 0; i < 5; i += 1) broadcastProviderReset()
      await flushMicrotasks()

      // #then no IPC, no pending work, no stacked listeners
      expect(mockOpenDoc).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(resetSubscribers.size).toBe(1)
      expect(readySubscribers.size).toBe(1)

      // #when the editor is finally unmounted
      provider.destroy()

      // #then both subscriptions are released — a provider that outlived its
      // window would rebind a note nothing is looking at and re-pin the doc.
      expect(resetSubscribers.size).toBe(0)
      expect(readySubscribers.size).toBe(0)

      doc.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops rebinding once destroyed so a closed note cannot reopen itself', async () => {
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })
    await provider.connect()
    provider.destroy()
    mockOpenDoc.mockClear()

    broadcastProviderReset()
    broadcastProviderReady()
    await Promise.resolve()
    await Promise.resolve()

    // #then a destroyed provider has released both subscriptions, so neither
    // signal must resurrect the note in main and pin a doc nothing is looking at.
    expect(resetSubscribers.size).toBe(0)
    expect(readySubscribers.size).toBe(0)
    expect(mockOpenDoc).not.toHaveBeenCalled()

    doc.destroy()
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
