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
}

export function createYjsDocRegistry<T extends DocEntryHandle>(
  createEntry: (noteId: string) => T
): YjsDocRegistry<T> {
  const slots = new Map<string, Slot<T>>()

  return {
    acquire(noteId, consumerId, onOwnerChange) {
      let slot = slots.get(noteId)
      if (!slot) {
        slot = {
          entry: createEntry(noteId),
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
    }
  }
}
