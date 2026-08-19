/**
 * Real-runtime wiring for the canvas {@link AssetServiceContext}.
 *
 * This is the ONE seam that reaches into the sync runtime: it reuses the
 * shared AttachmentSyncService / upload-queue singletons (via
 * `getCanvasAssetIO`), the sync token/url resolvers, the writeback-ignore
 * guard, and the server dereference client. It lives under `main/canvas/`
 * (a feature module) rather than in `canvas-handlers.ts` because the IPC
 * boundary may not import `main/sync/**`; the architecture check permits a
 * feature module to depend on the sync internals it composes here.
 */

import { getOrCreateVaultUuid } from '../../agent/storage/vault-id'
import { getDatabase, isDatabaseInitialized } from '../../database/client'
import { getCanvasAssetIO } from '../../ipc/sync-attachment-handlers'
import { markWritebackIgnored } from '../../sync/crdt-writeback'
import { getSyncEngine } from '../../sync/runtime'
import { resolveSyncServerUrl } from '../../sync/sync-server-url'
import { getValidAccessToken } from '../../sync/token-manager'
import { trackMainEvent } from '../../telemetry/track'
import { getStatus as getVaultStatus } from '../../vault/index'

import { dereferenceChunks, type DereferenceDeps } from './attachment-dereference'
import type { AssetServiceContext } from './asset-service'

/**
 * Assemble the real asset-service context, or `null` when the vault is not
 * open / the database is not initialized (read handlers degrade to empty,
 * write handlers skip asset work — offline-safe). The attachment IO is
 * resolved lazily so read-only asset lookups work even before sync is up.
 */
export function buildAssetServiceContext(): AssetServiceContext | null {
  if (!isDatabaseInitialized()) return null
  const vaultPath = getVaultStatus().path
  if (!vaultPath) return null

  const db = getDatabase()
  const vaultId = getOrCreateVaultUuid(db)

  const dereferenceDeps: DereferenceDeps = {
    getAccessToken: () => getValidAccessToken(),
    getSyncServerUrl: () => resolveSyncServerUrl(),
    getVaultId: () => vaultId
  }

  return {
    db,
    vaultId,
    vaultPath,
    uploadAttachment: async (canvasId, filePath) => {
      const io = getCanvasAssetIO()
      if (!io) throw new Error('Sync is not initialized')
      return io.uploadAttachment(canvasId, filePath)
    },
    downloadAttachment: async (attachmentId, targetPath) => {
      const io = getCanvasAssetIO()
      if (!io) throw new Error('Sync is not initialized')
      await io.downloadAttachment(attachmentId, targetPath)
    },
    dereference: async (chunkHashes) => {
      // Never throws: a 404 / missing token / offline degrades to `{ ok: false }` so GC can
      // never break a canvas save or delete, and the caller keeps the rows to retry later.
      const { ok } = await dereferenceChunks(chunkHashes, dereferenceDeps)
      return { ok }
    },
    markWritebackIgnored,
    trackEvent: trackMainEvent
  }
}

/**
 * Can canvas images be externalized right now?
 *
 * Never throws — like `dereference` above, "no" is an ordinary answer, not a
 * failure: editing a canvas while signed out or offline is a supported state,
 * and the images simply stay inline until sync is available again. Deliberately
 * does NOT call `getCanvasAssetIO()`: that CONSTRUCTS the shared upload queue,
 * which binds the NetworkMonitor of the moment, so asking the question early
 * (before the sync runtime exists) would leave the queue bound to nothing for
 * the rest of the session. A live sync engine is the cheap proxy for "the
 * runtime that owns that monitor is up".
 */
export async function canUploadCanvasAssets(): Promise<boolean> {
  if (!getSyncEngine()) return false
  try {
    return (await getValidAccessToken()) !== null
  } catch {
    return false
  }
}
