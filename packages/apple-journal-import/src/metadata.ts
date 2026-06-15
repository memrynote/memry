const MAP_TYPES = new Set(['generic-map', 'multi-pin-map'])
const IGNORED_TYPES = new Set(['photo', 'live-photo', 'video'])

/**
 * Convert a list of asset grid token strings into a frontmatter record.
 * Map asset types → `location: true`. Ignored media types are dropped.
 * Other tokens are included as kebab-cased keys with value `true`.
 */
export function tokensToFrontmatter(tokens: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const token of tokens) {
    const t = token.trim()
    if (!t) continue
    if (IGNORED_TYPES.has(t)) continue
    if (MAP_TYPES.has(t)) {
      result['location'] = true
      continue
    }
    result[t] = true
  }

  return result
}
