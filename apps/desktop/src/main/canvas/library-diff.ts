/**
 * Blob-to-rows reconciliation for the canvas library.
 *
 * Excalidraw's LibraryPersistenceAdapter always hands us the FULL item list on
 * save, while storage is one row per item (so a future sync type gets per-item
 * LWW and real tombstones). This module is the seam between those two shapes,
 * kept pure — no drizzle, no encryption — so every branch is testable without a
 * database or the keychain.
 *
 * Safety note: because "absent from the payload" means delete, callers must
 * pass the payload Excalidraw actually produced. Excalidraw calls
 * `adapter.load({ source: 'save' })` before each save precisely so items that
 * arrived in storage mid-session are merged in first; skipping that would let a
 * stale in-memory list tombstone rows it never knew about.
 */

import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'

/** A stored item reduced to what reconciliation needs. */
export interface StoredLibraryItem {
  id: string
  /** Decrypted LibraryItem JSON exactly as it was written. */
  json: string
}

export interface LibraryDiff {
  inserts: { id: string; json: string }[]
  updates: { id: string; json: string }[]
  /** Ids of live rows the payload no longer contains — soft-deleted, never dropped. */
  deletes: string[]
}

/**
 * Serializes a library item for storage and comparison. Both sides of a
 * comparison go through this, so a key-order difference can only produce a
 * redundant write, never a missed one.
 */
export function serializeLibraryItem(item: CanvasLibraryItem): string {
  return JSON.stringify(item)
}

export function diffLibraryItems(
  stored: readonly StoredLibraryItem[],
  incoming: readonly CanvasLibraryItem[]
): LibraryDiff {
  const storedById = new Map(stored.map((row) => [row.id, row.json]))
  const diff: LibraryDiff = { inserts: [], updates: [], deletes: [] }
  const seen = new Set<string>()

  for (const item of incoming) {
    // Excalidraw can hand back the same id twice (importing a library that
    // overlaps one already installed). First occurrence wins; writing both
    // would make the second overwrite the first in the same transaction.
    if (seen.has(item.id)) continue
    seen.add(item.id)

    const json = serializeLibraryItem(item)
    const existing = storedById.get(item.id)
    if (existing === undefined) {
      diff.inserts.push({ id: item.id, json })
    } else if (existing !== json) {
      diff.updates.push({ id: item.id, json })
    }
  }

  for (const row of stored) {
    if (!seen.has(row.id)) diff.deletes.push(row.id)
  }

  return diff
}
