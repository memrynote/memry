/**
 * Main-side, electron-free (de)serialization of the `memryAssets` scene
 * sidecar and extraction of externalized `memry-file://` file refs from a
 * serialized Excalidraw scene.
 *
 * Runs inside the bundled sync worker (canvas sync item-handler), so this
 * module must stay free of any electron import, direct or transitive — only
 * `JSON` and a type-only import of `MemryAssetDescriptor`.
 *
 * An externalized image's `files[fileId].dataURL` is a
 * `memry-file://local/.../attachments/canvas-assets/<contentHash>.<ext>` URL
 * (content-addressed). Pre-M5 scenes carry inline `data:` URIs instead and
 * have no top-level `memryAssets` key — every function here degrades to the
 * empty/absent case for those scenes so old canvases keep working untouched.
 */

import type { MemryAssetDescriptor } from '@memry/contracts/canvas-api'

const MEMRY_FILE_PREFIX = 'memry-file://'
const CANVAS_ASSET_MARKER = '/canvas-assets/'

/**
 * Parse a serialized Excalidraw scene and return the `{fileId, ref}` pairs
 * for every `files[fileId]` whose `dataURL` is a `memry-file://` ref (i.e.
 * already externalized). Inline `data:` URIs and anything else are skipped.
 * Returns `[]` on parse failure or a missing/malformed `files` map — never throws.
 */
export function extractSceneFileRefs(sceneJson: string): { fileId: string; ref: string }[] {
  let files: unknown
  try {
    const parsed = JSON.parse(sceneJson) as { files?: unknown }
    files = parsed.files
  } catch {
    return []
  }
  if (!files || typeof files !== 'object') return []

  const refs: { fileId: string; ref: string }[] = []
  for (const [fileId, file] of Object.entries(files as Record<string, unknown>)) {
    const dataURL = (file as { dataURL?: unknown } | null)?.dataURL
    if (typeof dataURL === 'string' && dataURL.startsWith(MEMRY_FILE_PREFIX)) {
      refs.push({ fileId, ref: dataURL })
    }
  }
  return refs
}

/**
 * Extract the content hash embedded in a canvas-asset `memry-file://` ref
 * (the basename minus extension). Returns `null` for anything that isn't a
 * canvas-asset ref (a `data:` URI, a non-canvas-asset memry-file ref, etc).
 * Refs always use forward slashes, including on Windows — `toMemryFileUrl`
 * normalizes backslashes before the ref is ever stored.
 */
export function contentHashFromRef(ref: string): string | null {
  if (!ref.startsWith(MEMRY_FILE_PREFIX) || !ref.includes(CANVAS_ASSET_MARKER)) return null

  const basename = ref.split('/').pop()
  if (!basename) return null

  const dotIndex = basename.lastIndexOf('.')
  return dotIndex > 0 ? basename.slice(0, dotIndex) : basename
}

/**
 * Read the top-level `memryAssets` sidecar from a serialized scene. Returns
 * `[]` when absent, malformed, or the scene fails to parse — this is the
 * backward-compat path for pre-M5 / inline-base64 scenes. Never throws.
 */
export function readMemryAssets(sceneJson: string): MemryAssetDescriptor[] {
  try {
    const parsed = JSON.parse(sceneJson) as { memryAssets?: unknown }
    return Array.isArray(parsed.memryAssets) ? (parsed.memryAssets as MemryAssetDescriptor[]) : []
  } catch {
    return []
  }
}

/**
 * Set the top-level `memryAssets` sidecar on a serialized scene, preserving
 * every other key. Throws if `sceneJson` can't be parsed — callers always
 * pass valid scene JSON, and silently swallowing a parse failure here would
 * corrupt the scene by dropping it.
 */
export function writeMemryAssets(sceneJson: string, descriptors: MemryAssetDescriptor[]): string {
  const parsed = JSON.parse(sceneJson) as Record<string, unknown>
  parsed.memryAssets = descriptors
  return JSON.stringify(parsed)
}
