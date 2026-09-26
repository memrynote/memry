import { useState, useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { YjsIpcProvider } from './yjs-ipc-provider'
import { createYjsDocRegistry, type DocEntryHandle } from './yjs-doc-registry'
import { createLogger } from '@/lib/logger'
import { useVaultScope } from '@/contexts/vault-scope'
import { useVaultWorkspaceLifecycle } from '@/lib/vault-workspace-lifecycle'
import { getVaultSwitchState } from '@/lib/vault-switch-state'
import { getCachedVaultStatus } from '@/lib/vault-status-cache'

const log = createLogger('useYjsCollaboration')

export interface YjsCollaborationState {
  fragment: Y.XmlFragment | null
  doc: Y.Doc | null
  provider: YjsIpcProvider | null
  isReady: boolean
}

export interface UseYjsCollaborationOptions {
  noteId: string | undefined
  enabled?: boolean
}

export interface UseYjsCollaborationReturn extends YjsCollaborationState {
  isRemoteUpdateRef: RefObject<boolean>
  /**
   * Whether THIS mount owns note-level side effects (task auto-conversion) for
   * the note. `true` for the sole consumer of a note in this window (the
   * ~universal case) and for a disabled/no-note mount; `false` only for a second
   * consumer of the same note in the same window (R17 — e.g. a canvas card while
   * the note is also open in a tab), so exactly one editor runs the effects.
   */
  isSideEffectOwner: boolean
}

/**
 * Snapshot of a shared doc entry's collaboration state, mirrored into each
 * consumer's React state. `fragment` / `doc` / `provider` stay null until
 * `connect()` resolves, and are null again on the fail-open path (the entry
 * destroys them) — byte-identical to the pre-registry single-consumer hook.
 */
interface EntrySnapshot {
  fragment: Y.XmlFragment | null
  doc: Y.Doc | null
  provider: YjsIpcProvider | null
  isReady: boolean
}

const CONNECTING_SNAPSHOT: EntrySnapshot = {
  fragment: null,
  doc: null,
  provider: null,
  isReady: false
}

interface DocEntry extends DocEntryHandle {
  isRemoteUpdateRef: RefObject<boolean>
  getSnapshot: () => EntrySnapshot
  subscribe: (listener: () => void) => () => void
  /** See `YjsIpcProviderConfig.canRebind`; set by the consumer that acquires the entry. */
  setRebindGate: (gate: () => boolean) => void
  resumeRebind: () => void
}

/**
 * Registry slot key for `noteId` in the vault workspace `scope`. The renderer
 * keeps several vaults mounted and note ids are not unique across vaults
 * (journal ids are the date, a copied vault folder keeps every id), so a slot
 * keyed by the id alone handed one vault's live Y.Doc to another vault's
 * editor, and its rebind pushed that content into the other vault's store.
 * Outside a workspace (`scope` null) the key is the bare noteId, as before.
 * Neither a vault path nor a note id contains NUL.
 */
function registrySlotKey(scope: string | null, noteId: string): string {
  return scope === null ? noteId : `${scope}\0${noteId}`
}

/**
 * ONE registry for the whole renderer window, with one slot per vault and note. The entry factory holds the exact
 * doc / provider / connect / teardown body the hook used to run inline, so a
 * single consumer (refCount === 1, the ~universal case) creates one doc,
 * connects once, and destroys once — behaviorally identical to the pre-registry
 * hook. Only a second consumer of the SAME note in the SAME window (R17) shares
 * the entry instead of building a diverging second Y.Doc.
 */
const docRegistry = createYjsDocRegistry<DocEntry>((slotKey, notifyChanged) => {
  // The doc guid and every IPC call use the plain noteId; main keys by it.
  const noteId = slotKey.slice(slotKey.indexOf('\0') + 1)
  const doc = new Y.Doc({ guid: noteId })
  const isRemoteUpdateRef: RefObject<boolean> = { current: false }

  doc.on('beforeTransaction', (tr: Y.Transaction) => {
    if (tr.origin === 'remote' || tr.origin === 'ipc-provider') {
      isRemoteUpdateRef.current = true
    }
  })
  doc.on('afterTransaction', () => {
    isRemoteUpdateRef.current = false
  })

  let rebindGate: () => boolean = () => true
  const provider = new YjsIpcProvider({ noteId, doc, canRebind: () => rebindGate() })

  const listeners = new Set<() => void>()
  let snapshot: EntrySnapshot = CONNECTING_SNAPSHOT
  let destroyed = false
  const publish = (next: EntrySnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
    // Read-only observers (useLiveFragmentQuery) hold no consumer slot, so they
    // are not in `listeners`; the registry fans out to them instead.
    notifyChanged()
  }

  provider
    .connect()
    .then(() => {
      if (destroyed) return
      const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
      publish({ fragment, doc, provider, isReady: true })
      log.debug('Collaboration ready', { noteId })
    })
    .catch((err) => {
      if (destroyed) return
      log.error('Failed to connect collaboration', err)
      provider.destroy()
      doc.destroy()
      isRemoteUpdateRef.current = false
      publish({ fragment: null, doc: null, provider: null, isReady: true })
    })

  return {
    isRemoteUpdateRef,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setRebindGate: (gate) => {
      rebindGate = gate
    },
    resumeRebind: () => provider.resumeRebind(),
    destroy: () => {
      destroyed = true
      provider.destroy()
      doc.destroy()
      isRemoteUpdateRef.current = false
    }
  }
})

const DISABLED_STATE: YjsCollaborationState = {
  fragment: null,
  doc: null,
  provider: null,
  isReady: false
}

const DUMMY_REMOTE_UPDATE_REF: RefObject<boolean> = { current: false }

type ActiveYjsCollaborationState = EntrySnapshot & {
  noteId: string | null
  isRemoteUpdateRef: RefObject<boolean>
}

const EMPTY_ACTIVE_STATE: ActiveYjsCollaborationState = {
  noteId: null,
  ...CONNECTING_SNAPSHOT,
  isRemoteUpdateRef: DUMMY_REMOTE_UPDATE_REF
}

export function useYjsCollaboration(
  options: UseYjsCollaborationOptions
): UseYjsCollaborationReturn {
  const { noteId, enabled = true } = options
  const consumerId = useRef<symbol>(Symbol('yjs-consumer')).current
  const [activeState, setActiveState] = useState<ActiveYjsCollaborationState>(EMPTY_ACTIVE_STATE)
  // Defaults to true so a disabled/no-note mount and the sole consumer both own
  // their side effects (parity: task auto-conversion has never been gated).
  const [isSideEffectOwner, setIsSideEffectOwner] = useState(true)
  const scope = useVaultScope()
  const lifecycle = useVaultWorkspaceLifecycle()
  /**
   * A release parked while the workspace is hidden. VaultStack keeps a vault
   * the user left mounted, and hiding runs this effect's cleanup: releasing
   * there destroyed the Y.Doc, so coming back built a new one, held the editor
   * behind the loading skeleton for a fresh handshake and rebuilt BlockNote.
   * Parked, the same doc and the same ready snapshot are there on reveal.
   */
  const parkedRef = useRef<{
    slotKey: string
    entry: DocEntry
    unpark: () => void
  } | null>(null)
  // The registry keeps the callback given at acquire, and a revealed consumer
  // keeps its slot, so the callback reaches the live effect through a ref.
  const ownerChangeRef = useRef<(isOwner: boolean) => void>(() => {})

  useEffect(() => {
    if (!noteId || !enabled) {
      setIsSideEffectOwner(true)
      return
    }

    // Main runs one vault at a time and resets its CRDT provider on every
    // switch. A doc kept for a hidden or leaving workspace must wait until its
    // own vault is the open one before it rebinds, or it would open this note
    // in the other vault's store. Outside a workspace there is one vault only.
    const mayRebind = (): boolean => {
      if (scope === null) return true
      if (lifecycle?.hidden) return false
      const { pending } = getVaultSwitchState()
      if (pending && pending.path !== scope) return false
      const open = getCachedVaultStatus()
      return open === null || open.path === scope
    }

    let destroyed = false
    ownerChangeRef.current = (isOwner) => {
      if (destroyed) return
      setIsSideEffectOwner(isOwner)
    }
    const onOwnerChange = (isOwner: boolean): void => ownerChangeRef.current(isOwner)
    const slotKey = registrySlotKey(scope, noteId)
    const parked = parkedRef.current
    let entry: DocEntry
    if (parked && parked.slotKey === slotKey) {
      // Revealed: the consumer slot was never given up, so reuse it.
      parked.unpark()
      parkedRef.current = null
      entry = parked.entry
    } else {
      if (parked) {
        parked.unpark()
        parkedRef.current = null
        docRegistry.release(parked.slotKey, consumerId)
      }
      entry = docRegistry.acquire(slotKey, consumerId, onOwnerChange)
    }
    entry.setRebindGate(mayRebind)
    setIsSideEffectOwner(docRegistry.isSideEffectOwner(slotKey, consumerId))

    const sync = (): void => {
      setActiveState({
        noteId,
        ...entry.getSnapshot(),
        isRemoteUpdateRef: entry.isRemoteUpdateRef
      })
    }
    // Read the entry's CURRENT state immediately so a second consumer that
    // mounts after the doc is already connected sees isReady synchronously.
    sync()
    const unsubscribe = entry.subscribe(sync)
    // Main may have come up for this vault while the workspace was hidden.
    entry.resumeRebind()

    return () => {
      destroyed = true
      unsubscribe()
      // Deferred a microtask so a setup that follows at once takes the slot
      // back: StrictMode re-runs effects on mount and on every reveal, and a
      // release in between destroyed the doc the reveal was meant to keep.
      const held: NonNullable<typeof parkedRef.current> = { slotKey, entry, unpark: () => {} }
      parkedRef.current = held
      queueMicrotask(() => {
        if (parkedRef.current !== held) return
        if (lifecycle?.hidden) {
          const release = (): void => {
            if (parkedRef.current === held) parkedRef.current = null
            docRegistry.release(slotKey, consumerId)
          }
          lifecycle.disposers.add(release)
          held.unpark = () => lifecycle.disposers.delete(release)
          return
        }
        parkedRef.current = null
        docRegistry.release(slotKey, consumerId)
      })
    }
  }, [noteId, enabled, consumerId, scope, lifecycle])

  // `isReady` is the entry's own "connect() has settled" flag, published once —
  // and connect() only resolves after performSyncHandshake has merged whatever
  // main holds, so it is exactly the moment a fragment is safe to hand out. A
  // late second consumer reads the same published snapshot, so it is right for
  // them too.
  //
  // This used to read `provider.isSynced` live instead. That answers a
  // different question: it also goes false when crdt:provider-reset marks the
  // binding stale — which is sign-out, with the editor mounted and the user
  // typing. Collapsing to DISABLED_STATE there pulled `yjsFragment` out from
  // under a live BlockNote editor, and `useCreateBlockNote` builds its
  // collaboration extension exactly once, so the fragment could never be
  // re-attached. Staleness belongs to the rebind (yjs-ipc-provider.ts), which
  // keeps this same Y.Doc and carries its unsent edits over on the next
  // handshake; it must not unbind the editor.
  const state =
    !noteId || !enabled || activeState.noteId !== noteId || !activeState.isReady
      ? DISABLED_STATE
      : {
          fragment: activeState.fragment,
          doc: activeState.doc,
          provider: activeState.provider,
          isReady: activeState.isReady
        }

  return { ...state, isRemoteUpdateRef: activeState.isRemoteUpdateRef, isSideEffectOwner }
}

/**
 * Whether THIS mount owns note-level side effects for `noteId`. Thin wrapper over
 * the collaboration hook's single registry consumer, so it never double-counts
 * against itself. ContentArea does NOT call this — it already runs
 * `useYjsCollaboration` and reads `isSideEffectOwner` from that return; calling
 * both in one component would register two consumers for one note and make the
 * sole editor report non-owner. Exported for standalone callers that want
 * ownership without wiring collaboration manually.
 */
export function useYjsSideEffectOwner(noteId: string): boolean {
  return useYjsCollaboration({ noteId }).isSideEffectOwner
}

/**
 * Does this window hold a LIVE Yjs fragment for `noteId` in vault `scope` right now?
 *
 * Three states, and the middle one is why this exists:
 *  - ready + fragment → the doc bound. Every editor on this note in this window
 *    gets this same fragment, so the whole-markdown debounce save is suppressed
 *    (`!yjsFragment` in content-area/hooks/use-editor-sync.ts) and a second
 *    editor cannot clobber the first. SAFE.
 *  - ready + no fragment → `connect()` REJECTED. The entry destroyed its
 *    provider and doc and published null for the life of the slot with no
 *    rebind, so every editor that binds this note is a whole-markdown saver
 *    again. NOT safe — and this state is reachable with a live, `idle` session
 *    (a rejecting `validateNoteForCrdt`, a throwing handshake), which is why
 *    the session predicate this replaced could not see it.
 *  - not ready → `connect()` has not settled, so which of the two above it will
 *    be is unknown. Reported NOT live: it may resolve to the null-fragment
 *    case, and a caller that treated "pending" as safe would under-fire exactly
 *    there. It does not flap a lock on and off, because ContentArea holds its
 *    render behind the same `isReady` — the pending window is the tab's own
 *    loading skeleton, and it ends in one transition, not an oscillation.
 *
 * No slot at all is likewise NOT live: nothing in this window has the note
 * bound, so there is nothing to prove the next editor will not fail open.
 *
 * `peek` registers no consumer, so asking this does not make the note's sole
 * editor report non-owner — the hazard that blocked #1504 in #1495.
 */
function hasLiveFragment(scope: string | null, noteId: string): boolean {
  const entry = docRegistry.peek(registrySlotKey(scope, noteId))
  if (!entry) return false
  const { isReady, fragment } = entry.getSnapshot()
  return isReady && fragment !== null
}

// Module-level so `useSyncExternalStore` gets one stable subscribe/getSnapshot
// pair for the life of the window (a fresh subscribe each render would tear the
// subscription down and rebuild it every time).
const observeRegistry = (listener: () => void): (() => void) => docRegistry.observe(listener)
const readRegistryVersion = (): number => docRegistry.version()

/**
 * Read-only fragment-liveness query, re-rendering the caller whenever an answer
 * could have changed (slot created/destroyed, `connect()` settled). The returned
 * function's identity changes with that version and only with it, so consumers
 * can memoize on it — canvas-card-overlay renders one card per visible element
 * and must not rebuild that list every render.
 */
export function useLiveFragmentQuery(): (noteId: string) => boolean {
  // Only the caller's own vault counts: another kept vault's doc for the same
  // id says nothing about the note this workspace renders.
  const scope = useVaultScope()
  const version = useSyncExternalStore(observeRegistry, readRegistryVersion, readRegistryVersion)
  return useMemo(() => {
    // `version` is referenced (no-op) purely as this memo's cache key — the
    // answer itself is read through `peek` at call time, so this must be a FRESH
    // closure per version, not the stable module function. Mirrors
    // `void claimFailedTick` in pages/canvas/canvas-card-overlay.tsx.
    void version
    return (noteId: string) => hasLiveFragment(scope, noteId)
  }, [version, scope])
}
