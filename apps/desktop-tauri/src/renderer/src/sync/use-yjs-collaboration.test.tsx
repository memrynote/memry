import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Activity, type ReactNode } from 'react'
import { VaultScopeProvider } from '@/contexts/vault-scope'
import {
  VaultWorkspaceLifecycleContext,
  createVaultWorkspaceLifecycle,
  disposeVaultWorkspace
} from '@/lib/vault-workspace-lifecycle'

/**
 * The `crdt_*` commands as `commands/editor.rs` answers them: an open is framed (header length,
 * JSON header, state, state vector) and records the arguments it got without the channel; an
 * edit is answered with a state vector.
 */
const ipc = vi.hoisted(() => ({
  open: null as unknown as Mock,
  resetHandlers: [] as Array<(event: { payload: null }) => void>,
  header: { needsSeed: false, readOnly: null as string | null },
  refuseEdits: null as string | null
}))
ipc.open = vi.fn()
const mockOpenDoc = ipc.open
const mockCloseDoc = vi.hoisted(() => vi.fn())

function framedEmptyDoc(header: Record<string, unknown>): ArrayBuffer {
  const doc = new Y.Doc()
  const state = Y.encodeStateAsUpdate(doc)
  const vector = Y.encodeStateVector(doc)
  const json = new TextEncoder().encode(JSON.stringify({ ...header, stateLength: state.length }))
  const bytes = new Uint8Array(4 + json.length + state.length + vector.length)
  new DataView(bytes.buffer).setUint32(0, json.length, false)
  bytes.set(json, 4)
  bytes.set(state, 4 + json.length)
  bytes.set(vector, 4 + json.length + state.length)
  return bytes.buffer
}

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    constructor(public onmessage: (data: ArrayBuffer) => void = () => {}) {}
  },
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === 'crdt_open_doc') {
      const { onUpdate: _channel, ...input } = args
      await ipc.open(input)
      return framedEmptyDoc(ipc.header)
    }
    // oxlint-disable-next-line typescript/only-throw-error -- Tauri rejects a command with its serialized `CommandError`, a plain object
    if (ipc.refuseEdits) throw { kind: 'invalid', code: ipc.refuseEdits, message: '' }
    return Y.encodeStateVector(new Y.Doc()).buffer
  })
}))

vi.mock('../../../generated/bindings', () => ({
  commands: { crdtCloseDoc: mockCloseDoc },
  events: {
    // Every provider subscribes to both rebind signals on connect.
    crdtProviderResetEvent: {
      listen: async (handler: (event: { payload: null }) => void) => {
        ipc.resetHandlers.push(handler)
        return () => {}
      }
    },
    crdtProviderReadyEvent: { listen: async () => () => {} },
    vaultLocksChangedEvent: { listen: async () => () => {} }
  }
}))

const providerResetHandlers = ipc.resetHandlers

beforeEach(() => {
  providerResetHandlers.length = 0
  ipc.header = { needsSeed: false, readOnly: null }
  ipc.refuseEdits = null
  mockOpenDoc.mockResolvedValue(undefined)
  mockCloseDoc.mockResolvedValue(null)
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

import * as Y from 'yjs'
import { useLiveFragmentQuery, useYjsCollaboration } from './use-yjs-collaboration'

describe('useYjsCollaboration', () => {
  it('stays disabled when note id is missing or collaboration is disabled', () => {
    const { result, rerender } = renderHook((props) => useYjsCollaboration(props), {
      initialProps: { noteId: undefined as string | undefined }
    })

    expect(result.current.isReady).toBe(false)
    expect(result.current.fragment).toBeNull()
    expect(result.current.provider).toBeNull()
    expect(mockOpenDoc).not.toHaveBeenCalled()

    rerender({ noteId: 'note-disabled', enabled: false })

    expect(result.current.isReady).toBe(false)
    expect(result.current.fragment).toBeNull()
    expect(result.current.provider).toBeNull()
    expect(mockOpenDoc).not.toHaveBeenCalled()
  })

  it('returns a synced fragment and cleans up when note id changes', async () => {
    const { result, rerender, unmount } = renderHook((props) => useYjsCollaboration(props), {
      initialProps: { noteId: 'note-1' }
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(result.current.fragment).not.toBeNull()
    expect(result.current.provider?.isSynced).toBe(true)
    expect(result.current.isRemoteUpdateRef.current).toBe(false)

    // Outside a vault workspace there is no vault to name.
    expect(mockOpenDoc).toHaveBeenCalledWith({ noteId: 'note-1' })

    rerender({ noteId: 'note-2' })

    await waitFor(() => expect(mockCloseDoc).toHaveBeenCalledWith('note-1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.provider?.noteId).toBe('note-2')

    unmount()
    await waitFor(() => expect(mockCloseDoc).toHaveBeenCalledWith('note-2'))
  })

  it('keeps the fragment bound when a provider reset marks the binding stale', async () => {
    const { result, rerender } = renderHook(() =>
      useYjsCollaboration({ noteId: 'note-signed-out' })
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))
    const fragment = result.current.fragment
    const doc = result.current.doc
    expect(fragment).not.toBeNull()

    // Vault close: the host drops the documents it served and broadcasts the
    // provider reset. The binding is dead, the DOC is not —
    // this window's Y.Doc is where the user's next keystrokes have to land,
    // and the rebind's handshake is what carries them over.
    act(() => {
      for (const handler of providerResetHandlers) handler({ payload: null })
    })
    // The reset itself changes no React state, so the collapse this guards
    // against only shows on the next render — and sign-out re-renders
    // ContentArea anyway, through the sync context it used to be gated on.
    rerender()

    expect(result.current.provider?.isSynced).toBe(false)
    expect(result.current.fragment).toBe(fragment)
    expect(result.current.doc).toBe(doc)
    expect(result.current.isReady).toBe(true)
  })

  it('fails open without a Yjs fragment when the CRDT doc cannot open', async () => {
    mockOpenDoc.mockRejectedValueOnce({ kind: 'notFound', code: 'note_not_found', message: '' })

    const { result, unmount } = renderHook(() => useYjsCollaboration({ noteId: 'note-missing' }))

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(result.current.fragment).toBeNull()
    expect(result.current.provider).toBeNull()

    unmount()
  })

  it('fails open on an unseeded locked document and leaves the lock to the lock store', async () => {
    // An empty note opened while locked: the markdown fallback outlives the lock, and the page's
    // lock store (`editable={!isLocked}`) follows the unlock where the open's answer cannot.
    ipc.header = { needsSeed: true, readOnly: 'locked' }

    const { result } = renderHook(() => useYjsCollaboration({ noteId: 'note-unseeded' }))

    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.fragment).toBeNull()
    expect(result.current.readOnly).toBeNull()
  })

  it('keeps an exclusion the open reported on an unseeded document', async () => {
    ipc.header = { needsSeed: true, readOnly: 'excluded' }

    const { result } = renderHook(() => useYjsCollaboration({ noteId: 'note-excluded' }))

    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.readOnly).toBe('excluded')
  })

  it('publishes the read-only reason of the open, and one a refused edit brings', async () => {
    const { result } = renderHook(() => useYjsCollaboration({ noteId: 'note-grows' }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.readOnly).toBeNull()

    ipc.refuseEdits = 'note_large_file'
    act(() => {
      result.current.fragment?.insert(0, [new Y.XmlText('pasted')])
    })

    await waitFor(() => expect(result.current.readOnly).toBe('large-file'))
    expect(result.current.fragment).not.toBeNull()
  })

  it('keeps the doc of a hidden vault workspace and hands it back on reveal', async () => {
    // VaultStack hides a workspace the user left instead of unmounting it.
    const lifecycle = createVaultWorkspaceLifecycle()
    let mode: 'visible' | 'hidden' = 'visible'
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Activity mode={mode}>
        <VaultWorkspaceLifecycleContext.Provider value={lifecycle}>
          <VaultScopeProvider vaultPath="/a">{children}</VaultScopeProvider>
        </VaultWorkspaceLifecycleContext.Provider>
      </Activity>
    )
    const { result, rerender } = renderHook(() => useYjsCollaboration({ noteId: 'note-kept' }), {
      wrapper
    })
    await waitFor(() => expect(result.current.isReady).toBe(true))
    const doc = result.current.doc
    expect(mockOpenDoc).toHaveBeenCalledTimes(1)

    lifecycle.hidden = true
    mode = 'hidden'
    rerender()
    // The release is deferred a microtask, then parked on the lifecycle.
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockCloseDoc).not.toHaveBeenCalled()
    expect(lifecycle.disposers.size).toBeGreaterThan(0)

    lifecycle.hidden = false
    mode = 'visible'
    rerender()
    await act(async () => {
      await Promise.resolve()
    })

    // Same doc, still ready on the first render: no skeleton, no new handshake.
    expect(result.current.isReady).toBe(true)
    expect(result.current.doc).toBe(doc)
    expect(mockOpenDoc).toHaveBeenCalledTimes(1)
    expect(lifecycle.disposers.size).toBe(0)

    // Dropped for good while hidden: the parked release runs.
    lifecycle.hidden = true
    mode = 'hidden'
    rerender()
    await act(async () => {
      await Promise.resolve()
    })
    disposeVaultWorkspace(lifecycle)
    await waitFor(() => expect(mockCloseDoc).toHaveBeenCalledWith('note-kept'))
  })

  it('gives two vault workspaces their own doc for the same note id', async () => {
    // Journal ids are the date, so two vaults open the same id on the same day.
    const workspace = (vaultPath: string) => {
      const lifecycle = createVaultWorkspaceLifecycle()
      const view = { mode: 'visible' as 'visible' | 'hidden' }
      const wrapper = ({ children }: { children: ReactNode }) => (
        <Activity mode={view.mode}>
          <VaultWorkspaceLifecycleContext.Provider value={lifecycle}>
            <VaultScopeProvider vaultPath={vaultPath}>{children}</VaultScopeProvider>
          </VaultWorkspaceLifecycleContext.Provider>
        </Activity>
      )
      const hook = renderHook(
        () => ({
          collab: useYjsCollaboration({ noteId: 'j2026-09-26' }),
          isLive: useLiveFragmentQuery()
        }),
        { wrapper }
      )
      return { lifecycle, view, ...hook }
    }
    const flush = () =>
      act(async () => {
        await Promise.resolve()
      })

    const a = workspace('/a')
    await waitFor(() => expect(a.result.current.collab.isReady).toBe(true))
    const b = workspace('/b')
    await waitFor(() => expect(b.result.current.collab.isReady).toBe(true))

    const docA = a.result.current.collab.doc
    const docB = b.result.current.collab.doc
    expect(docA).not.toBeNull()
    expect(docB).not.toBeNull()
    expect(docA).not.toBe(docB)
    // Main and IPC still see the plain note id.
    expect(docA?.guid).toBe('j2026-09-26')
    expect(docB?.guid).toBe('j2026-09-26')
    expect(a.result.current.collab.provider?.noteId).toBe('j2026-09-26')
    expect(b.result.current.collab.provider?.noteId).toBe('j2026-09-26')
    expect(mockOpenDoc).toHaveBeenCalledTimes(2)
    // Each open names its vault, so main refuses it once it serves the other one.
    expect(mockOpenDoc.mock.calls.map(([input]) => input)).toEqual([
      { noteId: 'j2026-09-26', vaultPath: '/a' },
      { noteId: 'j2026-09-26', vaultPath: '/b' }
    ])
    // Each is its note's sole editor in its own vault.
    expect(a.result.current.collab.isSideEffectOwner).toBe(true)
    expect(b.result.current.collab.isSideEffectOwner).toBe(true)

    // A's content does not show up in B.
    act(() => {
      a.result.current.collab.fragment?.insert(0, [new Y.XmlText('only in a')])
    })
    expect(a.result.current.collab.fragment?.length).toBe(1)
    expect(b.result.current.collab.fragment?.length).toBe(0)

    let docBDestroyed = false
    docB?.on('destroy', () => {
      docBDestroyed = true
    })

    // Hide A and reveal it: B keeps its doc and its ready state.
    a.lifecycle.hidden = true
    a.view.mode = 'hidden'
    a.rerender()
    await flush()
    expect(a.lifecycle.disposers.size).toBeGreaterThan(0)
    b.rerender()
    expect(b.result.current.collab.doc).toBe(docB)
    expect(b.result.current.collab.isReady).toBe(true)
    expect(b.result.current.isLive('j2026-09-26')).toBe(true)

    a.lifecycle.hidden = false
    a.view.mode = 'visible'
    a.rerender()
    await flush()
    expect(a.result.current.collab.doc).toBe(docA)
    expect(b.result.current.collab.doc).toBe(docB)

    // Evict A: its doc goes, B's stays live.
    a.lifecycle.hidden = true
    a.view.mode = 'hidden'
    a.rerender()
    await flush()
    disposeVaultWorkspace(a.lifecycle)
    await waitFor(() => expect(mockCloseDoc).toHaveBeenCalledTimes(1))
    expect(docBDestroyed).toBe(false)
    b.rerender()
    expect(b.result.current.collab.doc).toBe(docB)
    expect(b.result.current.isLive('j2026-09-26')).toBe(true)

    b.unmount()
    await flush()
    expect(docBDestroyed).toBe(true)
  })

  it('answers fragment liveness only for the caller vault', async () => {
    const inVault =
      (vaultPath: string) =>
      ({ children }: { children: ReactNode }) => (
        <VaultScopeProvider vaultPath={vaultPath}>{children}</VaultScopeProvider>
      )
    const editorA = renderHook(() => useYjsCollaboration({ noteId: 'note-shared-id' }), {
      wrapper: inVault('/a')
    })
    await waitFor(() => expect(editorA.result.current.isReady).toBe(true))

    const queryA = renderHook(() => useLiveFragmentQuery(), { wrapper: inVault('/a') })
    const queryB = renderHook(() => useLiveFragmentQuery(), { wrapper: inVault('/b') })
    const queryUnscoped = renderHook(() => useLiveFragmentQuery())
    expect(queryA.result.current('note-shared-id')).toBe(true)
    expect(queryB.result.current('note-shared-id')).toBe(false)
    expect(queryUnscoped.result.current('note-shared-id')).toBe(false)

    editorA.unmount()
    await waitFor(() => expect(queryA.result.current('note-shared-id')).toBe(false))
  })

  it('keeps the doc through an immediate cleanup and setup, as StrictMode runs on reveal', async () => {
    const { result, rerender } = renderHook((props) => useYjsCollaboration(props), {
      initialProps: { noteId: 'note-strict', enabled: true }
    })
    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })
    const doc = result.current.doc

    // Toggling `enabled` off and on inside one act is the same cleanup + setup
    // pair with no microtask in between.
    act(() => {
      rerender({ noteId: 'note-strict', enabled: false })
      rerender({ noteId: 'note-strict', enabled: true })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.doc).toBe(doc)
    expect(mockOpenDoc).toHaveBeenCalledTimes(1)
  })
})
