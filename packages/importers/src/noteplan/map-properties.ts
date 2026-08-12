/**
 * NotePlan frontmatter mixes real note properties (`type`, `status`, `owner`)
 * with keys that only drive NotePlan's own note styling. The styling keys
 * carry no meaning in Memry and would show up as noise in the properties
 * panel, so they are dropped — and reported, so the import summary can say so.
 *
 * Pure — no fs access.
 */

/** Frontmatter keys that exist purely to style a note inside NotePlan. */
const STYLING_KEYS = new Set(['icon', 'icon-color', 'bg-color', 'bg-color-dark', 'bg-pattern'])

export function mapProperties(frontmatter: Record<string, unknown>): {
  properties: Record<string, unknown>
  dropped: string[]
} {
  const properties: Record<string, unknown> = {}
  const dropped: string[] = []

  for (const [key, value] of Object.entries(frontmatter)) {
    if (STYLING_KEYS.has(key)) {
      dropped.push(key)
      continue
    }
    if (value === undefined) continue
    properties[key] = value
  }

  return { properties, dropped: dropped.sort() }
}
