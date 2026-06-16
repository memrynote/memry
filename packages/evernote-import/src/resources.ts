/**
 * Resource helpers for Evernote notes.
 *
 * The pure package does NOT compute MD5 hashes itself (that would require
 * Node's `crypto` module or a bundled hash implementation, breaking the
 * "no side-effects" contract). Instead, the desktop importer injects a
 * `computeHash` function so this module stays dependency-free and testable
 * with a simple fake.
 */

import type { EnexResource } from './types.ts'

/**
 * Build a hash → resource lookup map.
 *
 * @param resources  - The resource list from an {@link EnexNote}.
 * @param computeHash - Injected function: given a resource's base64 string,
 *   return the hex hash string (typically MD5 in Evernote's scheme).
 * @returns Map from hash hex string to the matching resource.
 */
export function resourceByHash(
  resources: EnexResource[],
  computeHash: (base64: string) => string
): Map<string, EnexResource> {
  const map = new Map<string, EnexResource>()
  for (const r of resources) {
    const hash = computeHash(r.base64)
    map.set(hash, r)
  }
  return map
}
