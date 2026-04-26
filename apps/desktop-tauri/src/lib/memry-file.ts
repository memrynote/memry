/**
 * Build a memry-file:// URL from an absolute local path.
 *
 * Mirrors the Electron helper of the same name. The Tauri custom URI
 * scheme handler in src-tauri/src/lib.rs decodes percent-encoded paths,
 * so encodeURI is correct here.
 */
export function toMemryFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/^\/+/, '')
  return `memry-file://local/${encodeURI(normalized)}`
}

export function fromMemryFileUrl(url: string): string {
  const prefix = 'memry-file://local/'
  if (!url.startsWith(prefix)) {
    throw new Error(`Invalid memry-file URL: ${url}`)
  }
  const rest = decodeURIComponent(url.slice(prefix.length))
  return '/' + rest
}
