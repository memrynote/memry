/**
 * Ref-counted, noteId-keyed registry that shares one Yjs doc entry across
 * consumers in a renderer window (R17). Without it, two BlockNote editors for
 * one note in one window each build a fresh Y.Doc, which diverge (main excludes
 * the source window from broadcast) and mis-teardown (window-keyed ref-count).
 *
 * Pure state over an injected `createEntry`, so it unit-tests without Yjs/IPC.
 * The real entry factory (Y.Doc + YjsIpcProvider + fragment) is injected by
 * use-yjs-collaboration (Task 4). refCount===1 behaves exactly like today.
 */
export interface DocEntryHandle {
  destroy: () => void
}

interface Slot<T> {
  entry: T
  consumers: Set<symbol>
  sideEffectOwner: symbol
  onOwnerChangeCallbacks: Map<symbol, (isOwner: boolean) => void>
}

export interface YjsDocRegistry<T> {
  acquire(noteId: string, consumerId: symbol, onOwnerChange?: (isOwner: boolean) => void): T
  release(noteId: string, consumerId: symbol): void
  isSideEffectOwner(noteId: string, consumerId: symbol): boolean
  refCount(noteId: string): number
  /**
   * The slot's entry, or null if this window holds none — WITHOUT registering a
   * consumer. That distinction is the whole point: `acquire` would make the sole
   * editor of the note report non-owner (see `useYjsSideEffectOwner`), which is
   * why the canvas note-edit lock could not ask this question before (#1495).
   * A reader that only wants to know whether a doc is live must not change who
   * owns it, nor keep the entry alive past its last real consumer.
   */
  peek(noteId: string): T | null
  /**
   * Fires when a slot is created or destroyed, and when a live entry reports its
   * own state changed (the `notifyChanged` handed to `createEntry`). Paired with
   * `version` for `useSyncExternalStore`, so a read-only observer re-renders on
   * exactly the transitions that can change a `peek` answer. Consumer churn
   * inside an existing slot is deliberately NOT a notification: refCount does
   * not change what `peek` returns.
   */
  observe(listener: () => void): () => void
  /** Monotonic counter bumped by every `observe` notification. */
  version(): number
}

export function createYjsDocRegistry<T extends DocEntryHandle>(
  createEntry: (noteId: string, notifyChanged: () => void) => T
): YjsDocRegistry<T> {
  const slots = new Map<string, Slot<T>>()
  const observers = new Set<() => void>()
  let changeVersion = 0
  const notifyChanged = (): void => {
    changeVersion += 1
    for (const observer of observers) observer()
  }

  return {
    acquire(noteId, consumerId, onOwnerChange) {
      let slot = slots.get(noteId)
      const created = slot === undefined
      if (!slot) {
        slot = {
          entry: createEntry(noteId, notifyChanged),
          consumers: new Set(),
          sideEffectOwner: consumerId,
          onOwnerChangeCallbacks: new Map()
        }
        slots.set(noteId, slot)
      }
      slot.consumers.add(consumerId)
      if (onOwnerChange) {
        slot.onOwnerChangeCallbacks.set(consumerId, onOwnerChange)
      }
      // After slots.set, so an observer that re-reads through `peek` sees the
      // slot it is being told about.
      if (created) notifyChanged()
      return slot.entry
    },
    release(noteId, consumerId) {
      const slot = slots.get(noteId)
      if (!slot) return
      slot.consumers.delete(consumerId)
      slot.onOwnerChangeCallbacks.delete(consumerId)
      if (slot.consumers.size === 0) {
        slot.entry.destroy()
        slots.delete(noteId)
        notifyChanged()
        return
      }
      if (slot.sideEffectOwner === consumerId) {
        // Promote any remaining consumer (iteration order = insertion order)
        // and notify ONLY that consumer so its React state can react.
        const promoted = slot.consumers.values().next().value as symbol
        slot.sideEffectOwner = promoted
        slot.onOwnerChangeCallbacks.get(promoted)?.(true)
      }
    },
    isSideEffectOwner(noteId, consumerId) {
      return slots.get(noteId)?.sideEffectOwner === consumerId
    },
    refCount(noteId) {
      return slots.get(noteId)?.consumers.size ?? 0
    },
    peek(noteId) {
      return slots.get(noteId)?.entry ?? null
    },
    observe(listener) {
      observers.add(listener)
      return () => {
        observers.delete(listener)
      }
    },
    version() {
      return changeVersion
    }
  }
}
