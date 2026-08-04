/**
 * Vault-open reconciliation for file-backed canvases.
 *
 * Two jobs, both idempotent and both safe to run on every open:
 *
 * 1. **Migration off the encrypted column.** Rows written before canvases became
 *    files carry a vault-key-encrypted `snapshot_ciphertext`. We decrypt once,
 *    write the `.excalidraw` file, and blank the column. A row we cannot decrypt
 *    (the master key changed under it — a local-only user upgrading to sync, a
 *    copied vault) keeps its ciphertext and stays `unreadable` in the UI: the
 *    ink is not thrown away, and it comes back if the old key ever returns.
 * 2. **Adoption.** Files in `canvases/` with no index row become canvases. This
 *    is what makes "copy the folder to another machine" work, and it is the same
 *    contract notes already have: the file is the truth, the table is an index.
 *
 * Deliberately additive: a row whose file is missing is reported, never
 * tombstoned. A half-copied vault (or a Dropbox mid-sync) must not delete
 * canvases, and a real delete already goes through the app.
 *
 * @module canvas/reconcile
 */

import { and, eq, isNull, ne } from 'drizzle-orm'
import { canvasEntityRefs, canvases, canvasLibraryItems } from '@memry/db-schema/data-schema'

import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import type { DataDb } from '../database'
import { createLogger } from '../lib/logger'
import { generateId } from '../lib/id'
import { extractEntityRefsFromScene } from './scene-refs'
import { decryptCanvasLibraryItemForVault, decryptCanvasSceneForVault } from './encryption'
import { readCanvasLibrary, writeCanvasLibrary } from './library-file'
import {
  allocateCanvasPath,
  canvasPathKey,
  ensureCanvasDir,
  listCanvasFiles,
  readCanvasFileSync,
  readCanvasMeta,
  resolveCanvasFile,
  stripCanvasMeta,
  withCanvasMeta,
  writeCanvasFileSync
} from './scene-file'
import { getLegacyCanvasVaultKey } from './vault-key'

const log = createLogger('CanvasReconcile')

export interface CanvasReconcileResult {
  migrated: number
  unreadable: number
  adopted: number
  missingFiles: number
  libraryItemsMigrated: number
}

/** Rows still holding a legacy encrypted snapshot. */
function legacyRows(db: DataDb): {
  id: string
  title: string | null
  createdAt: number
  updatedAt: number
  snapshotCiphertext: string
}[] {
  return db
    .select({
      id: canvases.id,
      title: canvases.title,
      createdAt: canvases.createdAt,
      updatedAt: canvases.updatedAt,
      snapshotCiphertext: canvases.snapshotCiphertext
    })
    .from(canvases)
    .where(and(isNull(canvases.filePath), ne(canvases.snapshotCiphertext, '')))
    .all()
}

function hasLegacyLibraryRows(db: DataDb): boolean {
  return (
    db
      .select({ id: canvasLibraryItems.id })
      .from(canvasLibraryItems)
      .where(isNull(canvasLibraryItems.deletedAt))
      .limit(1)
      .get() !== undefined
  )
}

/**
 * Resolves the vault key ONLY when there is legacy ciphertext to migrate.
 * `getOrInitializeLocalVaultKey` mints a master key when the keychain has none,
 * so calling it on every vault open would create key material for vaults that
 * never needed any.
 */
async function tryResolveVaultKey(db: DataDb, vaultId: string): Promise<Uint8Array | null> {
  try {
    return await getLegacyCanvasVaultKey(db, vaultId)
  } catch (err) {
    log.warn('No vault key available for canvas migration; legacy rows stay unreadable', { err })
    return null
  }
}

export async function reconcileCanvasFiles(
  db: DataDb,
  vaultPath: string,
  /** Defaults to this vault's uuid; passed explicitly by tests. */
  vaultId: string = getOrCreateVaultUuid(db)
): Promise<CanvasReconcileResult> {
  const result: CanvasReconcileResult = {
    migrated: 0,
    unreadable: 0,
    adopted: 0,
    missingFiles: 0,
    libraryItemsMigrated: 0
  }

  ensureCanvasDir(vaultPath)

  const pending = legacyRows(db)
  const legacyLibrary = hasLegacyLibraryRows(db)
  const vaultKey =
    pending.length > 0 || legacyLibrary ? await tryResolveVaultKey(db, vaultId) : null

  // ---- 1. migrate legacy encrypted snapshots -------------------------------
  const claimed = new Set<string>()
  for (const row of pending) {
    if (!vaultKey) {
      result.unreadable += 1
      continue
    }
    let scene: string
    try {
      scene = decryptCanvasSceneForVault(row.snapshotCiphertext, vaultKey)
    } catch (err) {
      // The master key changed under this row. Keep the ciphertext: it is the
      // only copy, and it decrypts again if the old key is ever restored.
      log.error('Canvas snapshot cannot be decrypted with the current vault key', {
        id: row.id,
        err
      })
      result.unreadable += 1
      continue
    }

    const filePath = allocateCanvasPath(vaultPath, row.title, claimed)
    claimed.add(filePath)
    writeCanvasFileSync(
      resolveCanvasFile(vaultPath, filePath),
      withCanvasMeta(scene, { id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt })
    )
    db.update(canvases)
      .set({ filePath, snapshotCiphertext: '' })
      .where(eq(canvases.id, row.id))
      .run()
    result.migrated += 1
  }

  // ---- 2. migrate the legacy encrypted shapes library ----------------------
  if (legacyLibrary && vaultKey) {
    const rows = db
      .select({ id: canvasLibraryItems.id, itemCiphertext: canvasLibraryItems.itemCiphertext })
      .from(canvasLibraryItems)
      .where(isNull(canvasLibraryItems.deletedAt))
      .all()
    const items: CanvasLibraryItem[] = []
    for (const row of rows) {
      try {
        items.push(
          JSON.parse(
            decryptCanvasLibraryItemForVault(row.itemCiphertext, vaultKey)
          ) as CanvasLibraryItem
        )
      } catch (err) {
        log.warn('Skipping unreadable canvas library item', { id: row.id, err })
      }
    }
    if (items.length > 0) {
      // Merge rather than replace: the file may already hold items this device
      // saved after the migration shipped.
      const existing = readCanvasLibrary(vaultPath)
      const byId = new Map(existing.map((item) => [(item as { id?: string }).id, item]))
      for (const item of items) {
        const id = (item as { id?: string }).id
        if (id && !byId.has(id)) byId.set(id, item)
      }
      writeCanvasLibrary(vaultPath, [...byId.values()])
      result.libraryItemsMigrated = items.length
    }
    // Tombstone the rows so the migration does not run again; the ciphertext
    // column is left intact for the same "old key might return" reason.
    db.update(canvasLibraryItems)
      .set({ deletedAt: Date.now() })
      .where(isNull(canvasLibraryItems.deletedAt))
      .run()
  }

  // ---- 3. adopt files this index has never seen ----------------------------
  const indexed = db.select({ id: canvases.id, filePath: canvases.filePath }).from(canvases).all()
  const knownIds = new Set(indexed.map((row) => row.id))
  // Keyed case- and Unicode-insensitively: macOS hands back decomposed (NFD)
  // filenames for the composed (NFC) name we wrote, and both macOS and Windows
  // are case-insensitive. Comparing raw strings would make every vault open
  // rediscover the same documents as new.
  const knownPaths = new Set(
    indexed
      .map((row) => row.filePath)
      .filter(Boolean)
      .map((filePath) => canvasPathKey(filePath!))
  )

  for (const filePath of listCanvasFiles(vaultPath)) {
    if (knownPaths.has(canvasPathKey(filePath))) continue
    const content = readCanvasFileSync(resolveCanvasFile(vaultPath, filePath))
    if (content === null) continue

    const meta = readCanvasMeta(content)
    const now = Date.now()
    if (meta && knownIds.has(meta.id)) {
      // Same canvas, moved or renamed outside the app — re-point the index
      // instead of minting a duplicate.
      db.update(canvases).set({ filePath }).where(eq(canvases.id, meta.id)).run()
      knownPaths.add(canvasPathKey(filePath))
      continue
    }

    const id = meta?.id ?? generateId()
    const title = titleFromPath(filePath)
    db.insert(canvases)
      .values({
        id,
        vaultId,
        title,
        filePath,
        snapshotCiphertext: '',
        vectorClock: {},
        createdAt: meta?.createdAt ?? now,
        updatedAt: meta?.updatedAt ?? now,
        deletedAt: null,
        lastSyncedAt: null,
        // Null clock: seedUnclocked pushes it on the next sync, which is how an
        // adopted canvas reaches the user's other devices.
        clock: null
      })
      .onConflictDoNothing()
      .run()

    // A file dropped in by hand has no sidecar; write one so the id survives
    // the next copy.
    if (!meta) {
      writeCanvasFileSync(
        resolveCanvasFile(vaultPath, filePath),
        withCanvasMeta(stripCanvasMeta(content), { id, createdAt: now, updatedAt: now })
      )
    }

    for (const ref of extractEntityRefsFromScene(stripCanvasMeta(content))) {
      db.insert(canvasEntityRefs)
        .values({ canvasId: id, entityType: ref.entityType, entityId: ref.entityId })
        .onConflictDoNothing()
        .run()
    }

    knownIds.add(id)
    knownPaths.add(canvasPathKey(filePath))
    result.adopted += 1
  }

  // ---- 4. report (never delete) rows whose file vanished -------------------
  for (const row of indexed) {
    if (!row.filePath) continue
    if (readCanvasFileSync(resolveCanvasFile(vaultPath, row.filePath)) === null) {
      result.missingFiles += 1
    }
  }

  if (
    result.migrated ||
    result.unreadable ||
    result.adopted ||
    result.missingFiles ||
    result.libraryItemsMigrated
  ) {
    log.info('Canvas files reconciled', result)
  }
  return result
}

function titleFromPath(filePath: string): string {
  // Case-insensitive extension strip: a `.EXCALIDRAW` file copied from a
  // Windows vault must not keep the extension in its title.
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.replace(/\.excalidraw$/i, '')
}
