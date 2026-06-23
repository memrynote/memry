/**
 * Classify a resource reference string into one of four categories.
 *
 * Pure function — no I/O.
 */

export type RefKind = 'data' | 'http' | 'file' | 'local'

/**
 * Classify a resource reference by its scheme.
 *
 * - `data`  — data: URI (inline, never fetched)
 * - `http`  — http:// or https:// URL (fetched via network)
 * - `file`  — file:// URL (resolved to local path)
 * - `local` — anything else (relative path on disk)
 */
export function classifyRef(ref: string): RefKind {
  if (ref.startsWith('data:')) return 'data'
  if (/^https?:\/\//i.test(ref)) return 'http'
  if (/^file:\/\//i.test(ref)) return 'file'
  return 'local'
}
