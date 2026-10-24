/**
 * Tag suggestion ranking.
 *
 * Shared by the folder/tag view's filter value input: on focus it offers the
 * most-used tags, and every keystroke re-ranks the vault's tags so a filter
 * value never has to be typed from memory.
 *
 * @module lib/tag-suggestions
 */

/** A vault tag as the suggestion list needs it. */
export interface TagSuggestion {
  /** Full tag name, hierarchy included (e.g. `work/design`). */
  name: string
  /** Stored color (name or hex); empty when the tag has no definition. */
  color?: string
  /** Usage count across notes — the ranking's primary signal. */
  count: number
}

/** Match quality, best first. Ties break on count, then name. */
const TIER_EXACT = 0
const TIER_PREFIX = 1
const TIER_SEGMENT_PREFIX = 2
const TIER_SUBSTRING = 3

/** Where `query` matches `name`, or `null` when it does not match at all. */
function tierFor(name: string, query: string): number | null {
  if (name === query) return TIER_EXACT
  if (name.startsWith(query)) return TIER_PREFIX
  // A nested tag is found by its leaf too: "design" surfaces "work/design".
  if (name.split('/').some((segment) => segment.startsWith(query))) return TIER_SEGMENT_PREFIX
  if (name.includes(query)) return TIER_SUBSTRING
  return null
}

/**
 * Rank `tags` for `query`, best match first, capped at `limit`.
 *
 * An empty query is the focus case: the most-used tags, unfiltered. Otherwise
 * only matching tags survive, ordered by how well they match and then by use.
 * Duplicate names (same tag from two sources) collapse onto the first one.
 */
export function rankTagSuggestions(
  tags: readonly TagSuggestion[],
  query: string,
  limit: number
): TagSuggestion[] {
  if (limit <= 0) return []

  // `#work` and `work` are the same query — a tag pill is written both ways.
  const normalized = query.trim().replace(/^#+/, '').toLowerCase()
  const seen = new Set<string>()
  const scored: Array<{ tag: TagSuggestion; tier: number; name: string }> = []

  for (const tag of tags) {
    const name = tag.name.trim()
    if (!name) continue
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue

    const tier = normalized === '' ? TIER_EXACT : tierFor(lower, normalized)
    if (tier === null) continue

    seen.add(lower)
    scored.push({ tag, tier, name: lower })
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.tag.count !== b.tag.count) return b.tag.count - a.tag.count
    return a.name.localeCompare(b.name)
  })

  return scored.slice(0, limit).map((entry) => entry.tag)
}

export default rankTagSuggestions
