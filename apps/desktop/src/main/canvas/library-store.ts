/**
 * Canvas library store — drizzle CRUD for canvas_library_items.
 *
 * Mirrors main/canvas/store.ts: lives outside main/ipc so the ipc layer never
 * imports queries directly (architecture boundary), and takes the vault key as
 * a parameter so it stays testable without the keychain.
 *
 * The library is vault-global, not per canvas — Excalidraw keeps one shared
 * collection, and the editor remounts per canvas id.
 */

import { and, asc, eq, isNull } from 'drizzle-orm'
import { canvasLibraryItems } from '@memry/db-schema/data-schema'
import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'
import type { DataDb } from '../database'
import { createLogger } from '../lib/logger'
import { decryptCanvasLibraryItemForVault, encryptCanvasLibraryItemForVault } from './encryption'
import { diffLibraryItems, type StoredLibraryItem } from './library-diff'

const log = createLogger('CanvasLibraryStore')

/**
 * Reads the live library rows as decrypted JSON strings.
 *
 * A row that fails to decrypt or parse is skipped rather than thrown: one bad
 * row (wrong vault key, truncated write) must not cost the user their entire
 * shapes panel. The skipped row stays on disk untouched.
 */
function loadStoredItems(db: DataDb, vaultKey: Uint8Array, vaultId: string): StoredLibraryItem[] {
  const rows = db
    .select({ id: canvasLibraryItems.id, itemCiphertext: canvasLibraryItems.itemCiphertext })
    .from(canvasLibraryItems)
    .where(and(eq(canvasLibraryItems.vaultId, vaultId), isNull(canvasLibraryItems.deletedAt)))
    .orderBy(asc(canvasLibraryItems.createdAt))
    .all()

  const items: StoredLibraryItem[] = []
  for (const row of rows) {
    try {
      items.push({
        id: row.id,
        json: decryptCanvasLibraryItemForVault(row.itemCiphertext, vaultKey)
      })
    } catch (err) {
      log.error('Skipping unreadable canvas library item', { id: row.id, err })
    }
  }
  return items
}

/** All library items for the vault, in insertion order. */
export function listCanvasLibraryItems(
  db: DataDb,
  vaultKey: Uint8Array,
  vaultId: string
): CanvasLibraryItem[] {
  const items: CanvasLibraryItem[] = []
  for (const stored of loadStoredItems(db, vaultKey, vaultId)) {
    try {
      items.push(JSON.parse(stored.json) as CanvasLibraryItem)
    } catch (err) {
      log.error('Skipping unparseable canvas library item', { id: stored.id, err })
    }
  }
  return items
}

/**
 * Reconciles the vault's library rows against the full item list Excalidraw
 * saved. Returns the number of rows written; 0 means nothing changed, which is
 * the common case since Excalidraw saves on every library mutation including
 * ones that only reorder in memory.
 */
export function saveCanvasLibraryItems(
  db: DataDb,
  vaultKey: Uint8Array,
  vaultId: string,
  incoming: readonly CanvasLibraryItem[]
): number {
  return db.transaction((tx) => {
    const diff = diffLibraryItems(loadStoredItems(tx as DataDb, vaultKey, vaultId), incoming)
    const now = Date.now()

    for (const item of diff.inserts) {
      tx.insert(canvasLibraryItems)
        .values({
          id: item.id,
          vaultId,
          itemCiphertext: encryptCanvasLibraryItemForVault(item.json, vaultKey),
          vectorClock: {},
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          lastSyncedAt: null,
          clock: null
        })
        // A tombstoned row keeps the id, so re-adding an item the user
        // previously deleted collides on the primary key; revive it instead of
        // failing the whole save.
        .onConflictDoUpdate({
          target: canvasLibraryItems.id,
          set: {
            itemCiphertext: encryptCanvasLibraryItemForVault(item.json, vaultKey),
            updatedAt: now,
            deletedAt: null
          }
        })
        .run()
    }

    for (const item of diff.updates) {
      tx.update(canvasLibraryItems)
        .set({
          itemCiphertext: encryptCanvasLibraryItemForVault(item.json, vaultKey),
          updatedAt: now
        })
        .where(eq(canvasLibraryItems.id, item.id))
        .run()
    }

    for (const id of diff.deletes) {
      // Soft delete: a hard delete would let the item resurrect from another
      // device once this table syncs.
      tx.update(canvasLibraryItems)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(canvasLibraryItems.id, id))
        .run()
    }

    return diff.inserts.length + diff.updates.length + diff.deletes.length
  })
}
