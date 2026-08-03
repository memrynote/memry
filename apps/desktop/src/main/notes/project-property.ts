/**
 * Pure helpers for the `project` frontmatter property: reading a note's project
 * name list, and adding/removing a single name from it. No DB or filesystem
 * access — the reconciler projector and the rename/delete propagation paths
 * both build on these.
 *
 * @module notes/project-property
 */

import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'

/**
 * The `project` value as a clean name list. Tolerates every shape a hand-edited
 * frontmatter can produce: a bare string, a nested array, nulls, blank entries.
 */
export function readProjectNames(properties: Record<string, unknown>): string[] {
  const raw = properties[PROJECT_PROPERTY_KEY]
  const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]

  const seen = new Set<string>()
  const names: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

/** Adds `name` to `names` unless a case-insensitive match is already present. */
export function withProjectName(names: string[], name: string): string[] {
  return names.some((n) => n.toLowerCase() === name.toLowerCase()) ? names : [...names, name]
}

/** Removes every case-insensitive match of `name` from `names`. */
export function withoutProjectName(names: string[], name: string): string[] {
  return names.filter((n) => n.toLowerCase() !== name.toLowerCase())
}
