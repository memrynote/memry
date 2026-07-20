/**
 * Canvas → sync-layer bridge.
 *
 * The IPC layer (`main/ipc/canvas-handlers.ts`) may not import `main/sync/**`
 * (architecture boundary), so canvas mutations reach the sync queue through
 * this feature module — the `main/settings/saved-filters-sync.ts` precedent.
 * Every canvas create/update/delete must call one of these, or edits write to
 * the data db but never sync.
 */

import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { trackMainEvent } from '../telemetry/track'
import { createLogger } from '../lib/logger'

const log = createLogger('CanvasSync')

/**
 * Pre-push size cap (§5.6). `encryptItemForPush` throws "Item too large" when
 * the UNCOMPRESSED payload `byteLength * 1.37 > 5 MB`; in the worker path that
 * throw degrades to `markFailed` → 7-day purge with NO UI. We measure the scene
 * (the payload is the scene plus a tiny metadata envelope) and stay comfortably
 * under the server cap so oversize canvases surface an error instead of
 * silently dropping. Images are externalized in M5; large freehand-ink scene
 * JSON still hits this.
 */
export const CANVAS_SCENE_SYNC_CAP_BYTES = 3_500_000

export function canvasSceneExceedsSyncCap(scene: string): boolean {
  return Buffer.byteLength(scene, 'utf8') > CANVAS_SCENE_SYNC_CAP_BYTES
}

export function syncCanvasCreate(canvasId: string): void {
  enqueueLocalSyncCreate('canvas', canvasId)
}

/**
 * Enqueue a canvas update push. Returns `false` (and emits `canvas_too_large`
 * telemetry) when the scene is too large to sync — the caller should surface a
 * user-facing error; the canvas is still saved locally, it just does not sync.
 */
export function syncCanvasUpdate(canvasId: string, scene?: string): boolean {
  if (scene !== undefined && canvasSceneExceedsSyncCap(scene)) {
    const byteCount = Buffer.byteLength(scene, 'utf8')
    log.warn('Canvas too large to sync; skipping push', { canvasId, byteCount })
    trackMainEvent('canvas_too_large', {
      surface: 'sync',
      action: 'push_blocked',
      objectType: 'canvas',
      result: 'skipped',
      metrics: { byteCount }
    })
    return false
  }

  enqueueLocalSyncUpdate('canvas', canvasId)
  return true
}

export function syncCanvasDelete(canvasId: string): void {
  enqueueLocalSyncDelete('canvas', canvasId)
}
