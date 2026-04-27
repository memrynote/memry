import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { YjsTauriProvider } from '@/lib/crdt/yjs-tauri-provider'
import { YjsIpcProvider } from './yjs-ipc-provider'

let mockInvoke: ReturnType<typeof vi.fn>
let cleanup: ReturnType<typeof vi.fn>

beforeEach(() => {
  cleanup = vi.fn()
  mockInvoke = vi.fn(async (cmd: string) => {
    if (cmd === 'crdt_sync_step_1') {
      const emptyDoc = new Y.Doc()
      const stateVector = Array.from(Y.encodeStateVector(emptyDoc))
      emptyDoc.destroy()
      return { diff: [], stateVector }
    }
    return { success: true }
  })
})

describe('YjsIpcProvider compatibility export', () => {
  it('points old imports at the Rust-backed Tauri provider', () => {
    expect(YjsIpcProvider).toBe(YjsTauriProvider)
  })

  it('uses the current CRDT command surface during connect and teardown', async () => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'local before connect')
    const provider = new YjsIpcProvider({
      noteId: 'note-compat',
      doc,
      invoke: mockInvoke,
      subscribeEvent: vi.fn(() => cleanup)
    })

    await provider.connect()

    expect(mockInvoke).toHaveBeenCalledWith('crdt_open_doc', { noteId: 'note-compat' })
    expect(mockInvoke).toHaveBeenCalledWith(
      'crdt_sync_step_1',
      expect.objectContaining({ noteId: 'note-compat', stateVector: expect.any(Array) })
    )
    expect(mockInvoke).toHaveBeenCalledWith(
      'crdt_sync_step_2',
      expect.objectContaining({ noteId: 'note-compat', diff: expect.any(Array) })
    )

    provider.destroy()

    expect(cleanup).toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledWith('crdt_close_doc', { noteId: 'note-compat' })

    doc.destroy()
  })
})
