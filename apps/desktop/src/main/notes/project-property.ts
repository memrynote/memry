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
 * Widen the raw value to a list of candidate entries.
 *
 * The JSON-array branch is a self-heal, not a convenience. A build that predates
 * the `project` property type stores the array through the generic `text` path
 * (`JSON.stringify` in, the literal string out), then pushes `project:
 * "[\"Alpha\"]"` on its next sync. Reading that as one name called `["Alpha"]`
 * would resolve to no project and silently drop the membership; it also covers
 * the same shape typed by hand into a markdown editor.
 */
function toEntryList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw == null || raw === '') return []

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Not JSON after all — fall through and treat it as a literal name.
      }
    }
  }

  return [raw]
}

/**
 * The `project` value as a clean name list. Tolerates every shape a hand-edited
 * frontmatter can produce: a bare string, a nested array, nulls, blank entries.
 */
export function readProjectNames(properties: Record<string, unknown>): string[] {
  const list = toEntryList(properties[PROJECT_PROPERTY_KEY])

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
