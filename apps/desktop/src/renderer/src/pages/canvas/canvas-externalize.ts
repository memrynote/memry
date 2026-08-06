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
 * keeps that file's data: URI (logged here) and does NOT abort the others
 * (the pre-push size guard is the backstop). Returns the (re-stringified)
 * scene; if nothing changed, returns the input unchanged.
 */
export async function externalizeSceneAssets(
  sceneJson: string,
  canvasId: string,
  upload: AssetUploader
): Promise<string> {
  const scene = JSON.parse(sceneJson) as SceneShape
  const files = scene.files
  if (!files || typeof files !== 'object') {
    return sceneJson
  }

  let changed = false
  for (const [fileId, file] of Object.entries(files)) {
    const dataURL = file?.dataURL
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) {
      continue
    }
    try {
      const decoded = decodeDataUrl(dataURL)
      const mimeType = file.mimeType ?? decoded.mimeType ?? 'application/octet-stream'
      const { ref } = await upload({ canvasId, fileId, mimeType, data: decoded.data })
      file.dataURL = ref
      changed = true
    } catch (err) {
      log.error('Failed to externalize canvas asset; keeping inline data URI', { fileId, err })
      trackRendererError('canvas_asset_externalize', err)
    }
  }

  return changed ? JSON.stringify(scene) : sceneJson
}
