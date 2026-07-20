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
  bumpCanvasClockLocalOnly,
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { trackMainEvent } from '../telemetry/track'
import { createLogger } from '../lib/logger'

const log = createLogger('CanvasSync')

/**
 * Pre-push size cap (§5.6). `encryptItemForPush` throws "Item too large" when
 * the UNCOMPRESSED push payload `byteLength * 1.37 > 5 MB` (≈3.65 MB of payload);
 * in the worker path that throw degrades to `markFailed` → 7-day purge with NO
 * UI. The payload embeds the scene as a JSON string value, so quote/backslash
 * escaping inflates it ~10-15% above the raw scene and the server then applies
 * the 1.37 factor — measuring the raw scene alone (an earlier 3.5 MB cap) left
 * almost no headroom. Cap the raw scene at 3 MB (→ ~3.4 MB escaped payload →
 * ~4.7 MB post-factor, comfortably < 5 MB) so oversize canvases surface an error
 * instead of silently dropping. Images are externalized in M5; large
 * freehand-ink scene JSON still hits this.
 */
export const CANVAS_SCENE_SYNC_CAP_BYTES = 3_000_000

export function canvasSceneExceedsSyncCap(scene: string): boolean {
  return Buffer.byteLength(scene, 'utf8') > CANVAS_SCENE_SYNC_CAP_BYTES
}

/** Log + emit `canvas_too_large` telemetry when a scene exceeds the cap. */
function reportTooLarge(canvasId: string, scene: string): void {
  const byteCount = Buffer.byteLength(scene, 'utf8')
  log.warn('Canvas too large to sync; skipping push', { canvasId, byteCount })
  trackMainEvent('canvas_too_large', {
    surface: 'sync',
    action: 'push_blocked',
    objectType: 'canvas',
    result: 'skipped',
    metrics: { byteCount }
  })
}

/**
 * Enqueue a canvas create push. Returns `false` (and emits `canvas_too_large`)
 * when the initial scene is too large to sync (e.g. an import or duplicate);
 * the canvas is still saved locally.
 */
export function syncCanvasCreate(canvasId: string, scene?: string): boolean {
  if (scene !== undefined && canvasSceneExceedsSyncCap(scene)) {
    reportTooLarge(canvasId, scene)
    return false
  }

  enqueueLocalSyncCreate('canvas', canvasId)
  return true
}

/**
 * Enqueue a canvas update push. Returns `false` (and emits `canvas_too_large`
 * telemetry) when the scene is too large to sync — the caller should surface a
 * user-facing error; the canvas is still saved locally, it just does not sync.
 */
export function syncCanvasUpdate(canvasId: string, scene?: string): boolean {
  if (scene !== undefined && canvasSceneExceedsSyncCap(scene)) {
    reportTooLarge(canvasId, scene)
    // The scene is kept on disk but not pushed; still advance the local clock so
    // a later remote edit resolves as concurrent (conflict copy) instead of
    // cleanly overwriting the retained-but-unsynced scene.
    bumpCanvasClockLocalOnly(canvasId)
    return false
  }

  enqueueLocalSyncUpdate('canvas', canvasId)
  return true
}

export function syncCanvasDelete(canvasId: string): void {
  enqueueLocalSyncDelete('canvas', canvasId)
}
