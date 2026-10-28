import { toCanonicalUrl, toWebviewUrl } from '@/lib/memry-file-url'

interface SceneFiles {
  [fileId: string]: { dataURL?: string } | undefined
}

/**
 * The `files` of a stored scene as Excalidraw loads them. A stored image is a canonical
 * `memry-file://local/...` URL, which WebView2 cannot load, so on Windows it becomes the
 * `https://memry-file.localhost` form. Other platforms get the same object back.
 */
export function sceneFilesForWebview<T extends SceneFiles>(
  files: T | undefined,
  platform?: string
): T | undefined {
  if (!files) return files
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every entry keeps its own shape; only `dataURL` text changes
  return Object.fromEntries(
    Object.entries(files).map(([id, file]) => [
      id,
      file?.dataURL ? { ...file, dataURL: toWebviewUrl(file.dataURL, platform) } : file
    ])
  ) as T
}

/**
 * A scene Excalidraw serialized, with every `https://memry-file.localhost` image URL put back to
 * the canonical form: what reaches the vault file and sync is the same on every OS, and equals
 * what the stored scene was loaded from.
 */
export function canonicalSceneJson(sceneJson: string): string {
  if (!sceneJson.includes('.localhost/local')) return sceneJson
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- serializeAsJSON output, read defensively
  const scene = JSON.parse(sceneJson) as { files?: SceneFiles }
  let changed = false
  for (const file of Object.values(scene.files ?? {})) {
    const canonical = file?.dataURL ? toCanonicalUrl(file.dataURL) : undefined
    if (file && canonical !== file.dataURL) {
      file.dataURL = canonical
      changed = true
    }
  }
  return changed ? JSON.stringify(scene) : sceneJson
}
