import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import * as Y from 'yjs'

/**
 * The fallback of a locked, unseeded note while the lock store cannot list the locks. The store
 * loads once per renderer, so this file keeps its own module instance, apart from
 * `use-yjs-collaboration.test.tsx`, whose list succeeds.
 */
const host = vi.hoisted(() => ({
  locksChanged: [] as Array<(event: { payload: { notes: string[]; folders: string[] } }) => void>
}))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    constructor(public onmessage: (data: ArrayBuffer) => void = () => {}) {}
  },
  invoke: vi.fn(async () => {
    const doc = new Y.Doc()
    const state = Y.encodeStateAsUpdate(doc)
    const json = new TextEncoder().encode(
      JSON.stringify({ needsSeed: true, readOnly: 'locked', stateLength: state.length })
    )
    const bytes = new Uint8Array(4 + json.length + state.length)
    new DataView(bytes.buffer).setUint32(0, json.length, false)
    bytes.set(json, 4)
    bytes.set(state, 4 + json.length)
    return bytes.buffer
  })
}))

vi.mock('../../../generated/bindings', () => ({
  commands: {
    crdtCloseDoc: async () => null,
    vaultLocksList: async () => {
      throw new Error('vault locks unavailable')
    }
  },
  events: {
    crdtProviderResetEvent: { listen: async () => () => {} },
    crdtProviderReadyEvent: { listen: async () => () => {} },
    vaultLocksChangedEvent: {
      listen: async (
        handler: (event: { payload: { notes: string[]; folders: string[] } }) => void
      ) => {
        host.locksChanged.push(handler)
        return () => {}
      }
    }
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { useYjsCollaboration } from './use-yjs-collaboration'

describe('useYjsCollaboration with a lock store that failed to load', () => {
  it('keeps an empty locked note read-only until the store holds the locks once', async () => {
    const { result } = renderHook(() => useYjsCollaboration({ noteId: 'note-locked' }))

    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.fragment).toBeNull()
    // The list failed: the empty store says nothing about the lock.
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.readOnly).toBe('locked')

    // A lock change broadcast gives the store its first answer; the note is no longer locked.
    act(() => {
      for (const handler of host.locksChanged) handler({ payload: { notes: [], folders: [] } })
    })
    await waitFor(() => expect(result.current.readOnly).toBeNull())
  })
})
