import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

const { mockInvoke, mockSubscribeEvent } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockSubscribeEvent: vi.fn()
}))

vi.mock('@/lib/ipc/invoke', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args)
}))

vi.mock('@/lib/ipc/forwarder', () => ({
  subscribeEvent: (...args: unknown[]) => mockSubscribeEvent(...args)
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { YjsIpcProvider } from './yjs-ipc-provider'

beforeEach(() => {
  mockInvoke.mockResolvedValue({ success: true })
  mockSubscribeEvent.mockReturnValue(() => {})
})

afterEach(() => {
  vi.clearAllMocks()
})

async function flushPromises(count = 6): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve()
  }
}

function emptyStateVector(): number[] {
  const doc = new Y.Doc()
  const stateVector = Array.from(Y.encodeStateVector(doc))
  doc.destroy()
  return stateVector
}

describe('YjsIpcProvider', () => {
  it('uses real CRDT commands and update event during connect', async () => {
    const doc = new Y.Doc()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'crdt_sync_step_1') {
        return { diff: [], stateVector: Array.from(Y.encodeStateVector(doc)) }
      }
      return { success: true }
    })
    const provider = new YjsIpcProvider({ noteId: 'note-9', doc })

    await provider.connect()

    expect(mockSubscribeEvent).toHaveBeenCalledWith('crdt-update', expect.any(Function))
    expect(mockInvoke).toHaveBeenCalledWith('crdt_open_doc', { noteId: 'note-9' })
    expect(mockInvoke).toHaveBeenCalledWith(
      'crdt_sync_step_1',
      expect.objectContaining({ noteId: 'note-9', stateVector: expect.any(Array) })
    )
    expect(provider.isSynced).toBe(true)

    provider.destroy()
    doc.destroy()
  })

  it('sends local updates through crdt_apply_update input envelope', async () => {
    const doc = new Y.Doc()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'crdt_sync_step_1') {
        return { diff: [], stateVector: Array.from(Y.encodeStateVector(doc)) }
      }
      return { success: true }
    })
    const provider = new YjsIpcProvider({ noteId: 'note-11', doc })

    await provider.connect()
    doc.getText('body').insert(0, 'hello')

    expect(mockInvoke).toHaveBeenCalledWith('crdt_apply_update', {
      input: {
        noteId: 'note-11',
        update: expect.any(Array),
        origin: null
      }
    })

    provider.destroy()
    doc.destroy()
  })

  it('sends oversized local updates through chunked transport', async () => {
    const doc = new Y.Doc()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'crdt_sync_step_1') {
        return { diff: [], stateVector: Array.from(Y.encodeStateVector(doc)) }
      }
      return { success: true }
    })
    const provider = new YjsIpcProvider({ noteId: 'note-large', doc })

    await provider.connect()
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
        input: expect.objectContaining({
          transferId: expect.any(String),
          offset: 0,
          bytes: expect.any(Array)
        })
      })
    )
    expect(mockInvoke).toHaveBeenCalledWith('crdt_apply_update_chunk_finish', {
      input: {
        noteId: 'note-large',
        transferId: expect.any(String),
        origin: null
      }
    })

    provider.destroy()
    doc.destroy()
  })

  it('sends oversized handshake diffs through chunked transport', async () => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'x'.repeat(12_000))
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'crdt_sync_step_1') {
        return { diff: [], stateVector: emptyStateVector() }
      }
      return { success: true }
    })
    const provider = new YjsIpcProvider({ noteId: 'note-handshake-large', doc })

    await provider.connect()

    expect(mockInvoke).not.toHaveBeenCalledWith('crdt_sync_step_2', expect.anything())
    expect(mockInvoke).toHaveBeenCalledWith('crdt_apply_update_chunk_start', {
      input: {
        noteId: 'note-handshake-large',
        transferId: expect.any(String),
        totalBytes: expect.any(Number)
      }
    })
    expect(mockInvoke).toHaveBeenCalledWith('crdt_apply_update_chunk_finish', {
      input: {
        noteId: 'note-handshake-large',
        transferId: expect.any(String),
        origin: null
      }
    })

    provider.destroy()
    doc.destroy()
  })

  it('swallows rejection from closeDoc during teardown', async () => {
    mockInvoke.mockRejectedValueOnce(new Error("No handler registered for 'crdt_close_doc'"))
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-42', doc })

    expect(() => provider.destroy()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('crdt_close_doc', { noteId: 'note-42' })

    doc.destroy()
  })

  it('invokes closeDoc with correct noteId on disconnect', () => {
    const doc = new Y.Doc()
    const provider = new YjsIpcProvider({ noteId: 'note-7', doc })

    provider.disconnect()

    expect(mockInvoke).toHaveBeenCalledWith('crdt_close_doc', { noteId: 'note-7' })
    expect(provider.isSynced).toBe(false)

    doc.destroy()
  })
})
