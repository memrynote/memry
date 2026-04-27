import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createRendererOrigin } from './origin-tags'
import { YjsTauriProvider } from './yjs-tauri-provider'

type CrdtUpdatePayload = { noteId: string; update: number[]; origin: number }

let mockInvoke: ReturnType<typeof vi.fn>
let eventHandler: ((payload: CrdtUpdatePayload) => void) | null
let cleanup: ReturnType<typeof vi.fn>

beforeEach(() => {
  eventHandler = null
  cleanup = vi.fn()
  mockInvoke = vi.fn(async (cmd: string) => {
    if (cmd === 'crdt_sync_step_1') {
      const doc = new Y.Doc()
      const stateVector = Array.from(Y.encodeStateVector(doc))
      doc.destroy()
      return { diff: [], stateVector }
    }
    return { success: true }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

async function flushPromises(count = 6): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve()
  }
}

function createProvider(noteId = 'note-1'): { doc: Y.Doc; provider: YjsTauriProvider } {
  const doc = new Y.Doc()
  const provider = new YjsTauriProvider({
    noteId,
    doc,
    invoke: mockInvoke,
    subscribeEvent: (_eventName, handler) => {
      eventHandler = handler
      return cleanup
    }
  })

  return { doc, provider }
}

describe('YjsTauriProvider', () => {
  it('opens the Rust doc and subscribes to CRDT updates during connect', async () => {
    const { doc, provider } = createProvider('note-open')

    await provider.connect()

    expect(mockInvoke).toHaveBeenCalledWith('crdt_open_doc', { noteId: 'note-open' })
    expect(mockInvoke).toHaveBeenCalledWith(
      'crdt_sync_step_1',
      expect.objectContaining({ noteId: 'note-open', stateVector: expect.any(Array) })
    )
    expect(eventHandler).toEqual(expect.any(Function))
    expect(provider.isSynced).toBe(true)

    provider.destroy()
    doc.destroy()
  })

  it('persists local updates with the renderer origin', async () => {
    const { doc, provider } = createProvider('note-local')
    await provider.connect()
    mockInvoke.mockClear()

    doc.getText('body').insert(0, 'hello')
    await flushPromises()

    expect(mockInvoke).toHaveBeenCalledWith('crdt_apply_update', {
      input: {
        noteId: 'note-local',
        update: expect.any(Array),
        origin: createRendererOrigin()
      }
    })

    provider.destroy()
    doc.destroy()
  })

  it('drops echoed updates from the same renderer origin', async () => {
    const { doc, provider } = createProvider('note-echo')
    await provider.connect()
    mockInvoke.mockClear()

    eventHandler?.({
      noteId: 'note-echo',
      update: Array.from(Y.encodeStateAsUpdate(new Y.Doc())),
      origin: createRendererOrigin()
    })
    await flushPromises()

    expect(mockInvoke).not.toHaveBeenCalled()

    provider.destroy()
    doc.destroy()
  })

  it('applies remote updates from a foreign origin without re-sending them', async () => {
    const source = new Y.Doc()
    source.getText('body').insert(0, 'remote text')
    const update = Array.from(Y.encodeStateAsUpdate(source))
    const { doc, provider } = createProvider('note-remote')

    await provider.connect()
    mockInvoke.mockClear()
    eventHandler?.({ noteId: 'note-remote', update, origin: 9_999 })
    await flushPromises()

    expect(doc.getText('body').toString()).toBe('remote text')
    expect(mockInvoke).not.toHaveBeenCalled()

    provider.destroy()
    source.destroy()
    doc.destroy()
  })

  it('streams oversized local updates through chunk commands', async () => {
    const { doc, provider } = createProvider('note-large')
    await provider.connect()
    mockInvoke.mockClear()

    doc.getText('body').insert(0, 'x'.repeat(12_000))
    await flushPromises()

    expect(mockInvoke).toHaveBeenCalledWith('crdt_apply_update_chunk_start', {
      input: {
        noteId: 'note-large',
        transferId: expect.any(String),
        totalBytes: expect.any(Number)
      }
    })
    expect(mockInvoke).toHaveBeenCalledWith(
      'crdt_apply_update_chunk_append',
      expect.objectContaining({
        input: expect.objectContaining({ transferId: expect.any(String), offset: 0 })
      })
    )
    expect(mockInvoke).toHaveBeenCalledWith('crdt_apply_update_chunk_finish', {
      input: {
        noteId: 'note-large',
        transferId: expect.any(String),
        origin: createRendererOrigin()
      }
    })

    provider.destroy()
    doc.destroy()
  })

  it('unsubscribes and closes the Rust doc on destroy', async () => {
    const { doc, provider } = createProvider('note-close')
    await provider.connect()
    mockInvoke.mockClear()

    provider.destroy()

    expect(cleanup).toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledWith('crdt_close_doc', { noteId: 'note-close' })

    doc.destroy()
  })
})
