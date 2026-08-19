/**
 * Externalizes inline base64 images out of a serialized Excalidraw scene.
 *
 * serializeAsJSON embeds every image as a base64 `data:` URI inside the
 * scene's `files` map. That's fine for a single local vault, but ships raw
 * image bytes through sync as JSON text (no dedup, no GC, R2/D1 bloat). This
 * module rewrites each `data:` file to the `memry-file://` ref returned by
 * `canvas:upload-asset` (main-process dedup/GC already exist — this is what
 * finally calls them). Excalidraw-runtime-free (types only) so it
 * unit-tests without the library.
 */

import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'

const log = createLogger('SpatialCanvas')

export interface AssetUploader {
  (input: { canvasId: string; fileId: string; mimeType: string; data: ArrayBuffer }): Promise<{
    ref: string
  }>
}

export interface ExternalizeOptions {
  /**
   * "Can this device upload right now?", asked once per save BEFORE any image
   * is decoded or shipped over IPC. Resolving false (signed out, sync not
   * running) makes the whole pass a quiet no-op: the images stay inline and a
   * later save externalizes them once sync is back. A gate that itself fails
   * counts as false. Absent means "just try", which is what a caller with no
   * gate (and the unit tests) get.
   */
  canUpload?: () => Promise<boolean>
}

/** One remembered upload failure. */
interface FailedUpload {
  /** Skip this file until something about sync/auth/network moves. */
  blocked: boolean
  /** Telemetry already carries this failure; never report it twice. */
  reported: boolean
}

/**
 * Files whose upload failed, keyed by (canvasId, fileId).
 *
 * Without this, one stable failure was re-attempted on every 800 ms-debounced
 * save — measured at up to 48 errors/minute for a single canvas (#1581).
 */
const failedUploads = new Map<string, FailedUpload>()

const failureKey = (canvasId: string, fileId: string): string => `${canvasId}::${fileId}`

/**
 * Let every remembered failure be attempted again. Called when sync state
 * changes (auth restored, network back, sync resumed), so recovery from a
 * transient failure is automatic instead of needing a restart. Telemetry stays
 * suppressed for failures already reported — a retry is not a new failure.
 */
export function retryCanvasAssetUploads(): void {
  for (const entry of failedUploads.values()) {
    entry.blocked = false
  }
}

function recordFailure(canvasId: string, fileId: string, err: unknown): void {
  const key = failureKey(canvasId, fileId)
  const reported = failedUploads.get(key)?.reported ?? false
  failedUploads.set(key, { blocked: true, reported: true })
  if (reported) return
  log.error('Failed to externalize canvas asset; keeping inline data URI', { fileId, err })
  trackRendererError('canvas_asset_externalize', err)
}

interface ExcalidrawFileEntry {
  mimeType?: string
  dataURL?: string
}

interface SceneShape {
  files?: Record<string, ExcalidrawFileEntry>
}

const DATA_URL_RE = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s

/** Decodes a `data:<mime>;base64,<payload>` URI into raw bytes + parsed mime type. */
function decodeDataUrl(dataURL: string): { mimeType: string | undefined; data: ArrayBuffer } {
  const match = DATA_URL_RE.exec(dataURL)
  const mimeType = match?.[1] || undefined
  const base64 = match?.[2] ?? ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return { mimeType, data: bytes.buffer }
}

/**
 * Externalize inline base64 images out of a serialized Excalidraw scene.
 * For each files[fileId] whose dataURL is a `data:` URI, uploads the bytes via
 * `upload` and rewrites dataURL to the returned memry-file:// ref.
 * Already-externalized (memry-file://) files and non-`data:` entries are left
 * as-is (idempotent — re-saving does not re-upload). A single failed upload
 * keeps that file's data: URI (logged and remembered here, so the next save
 * does not repeat it) and does NOT abort the others (the pre-push size guard
 * is the backstop). Returns the (re-stringified) scene; if nothing changed,
 * returns the input unchanged.
 */
export async function externalizeSceneAssets(
  sceneJson: string,
  canvasId: string,
  upload: AssetUploader,
  options: ExternalizeOptions = {}
): Promise<string> {
  const scene = JSON.parse(sceneJson) as SceneShape
  const files = scene.files
  if (!files || typeof files !== 'object') {
    return sceneJson
  }

  const pending: { fileId: string; file: ExcalidrawFileEntry; dataURL: string }[] = []
  for (const [fileId, file] of Object.entries(files)) {
    const dataURL = file?.dataURL
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) {
      continue
    }
    if (failedUploads.get(failureKey(canvasId, fileId))?.blocked) {
      continue
    }
    pending.push({ fileId, file, dataURL })
  }
  if (pending.length === 0) {
    return sceneJson
  }

  if (options.canUpload && !(await canUploadNow(options.canUpload, canvasId))) {
    // Signed out / sync not running is a normal state in an offline-first app,
    // not a failure: leave the images inline, say nothing, and let a later save
    // externalize them once uploads are possible again.
    log.debug('Skipping canvas asset externalization; uploads unavailable', {
      canvasId,
      fileCount: pending.length
    })
    return sceneJson
  }

  let changed = false
  for (const { fileId, file, dataURL } of pending) {
    try {
      const decoded = decodeDataUrl(dataURL)
      const mimeType = file.mimeType ?? decoded.mimeType ?? 'application/octet-stream'
      const { ref } = await upload({ canvasId, fileId, mimeType, data: decoded.data })
      file.dataURL = ref
      failedUploads.delete(failureKey(canvasId, fileId))
      changed = true
    } catch (err) {
      recordFailure(canvasId, fileId, err)
    }
  }

  return changed ? JSON.stringify(scene) : sceneJson
}

/** The gate itself must never break a save: an unreachable gate reads as "no". */
async function canUploadNow(canUpload: () => Promise<boolean>, canvasId: string): Promise<boolean> {
  try {
    return await canUpload()
  } catch (err) {
    log.debug('Canvas asset upload gate unavailable; keeping images inline', { canvasId, err })
    return false
  }
}
