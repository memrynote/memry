/**
 * Multi-tag (AND) selection logic for a tag-scoped folder view.
 *
 * A tag tab is defined by its PRIMARY tag — that is what the tab is, what its
 * title and its rename/delete actions act on. Ctrl/Cmd-click adds or removes
 * EXTRA tags that are ANDed onto it; the primary itself is not toggleable, and
 * clearing the extras returns the page to the plain single-tag view every
 * earlier build showed.
 *
 * Comparison folds case, matching the tag store (migration 0034) and
 * `scopeKey`. The user's own casing is preserved in what gets stored, so a
 * chip still reads `#Work`, not `#work`.
 *
 * @module lib/tag-filter-selection
 */

/** Case- and whitespace-folded comparison key for a tag. */
export function tagKey(tag: string): string {
  return tag.trim().toLowerCase()
}

/** Whether `tag` is already among the ANDed tags. */
export function andTagsInclude(andTags: readonly string[], tag: string): boolean {
  const needle = tagKey(tag)
  return andTags.some((existing) => tagKey(existing) === needle)
}

/**
 * Toggle `tag`'s membership in the ANDed set.
 *
 * The primary tag and blank input are no-ops — removing the primary would
 * leave a tag page with no tag, which is the tag hub, not a filter state.
 */
export function toggleAndTag(
  primaryTag: string,
  andTags: readonly string[],
  tag: string
): string[] {
  const needle = tagKey(tag)
  if (needle === '' || needle === tagKey(primaryTag)) return [...andTags]
  if (andTagsInclude(andTags, tag)) {
    return andTags.filter((existing) => tagKey(existing) !== needle)
  }
  return [...andTags, tag.trim()]
}

/**
 * Clean a candidate AND set: drop blanks, drop the primary, de-duplicate
 * case-insensitively, keep click order and the user's casing.
 */
export function sanitizeAndTags(primaryTag: string, andTags: readonly string[]): string[] {
  const primary = tagKey(primaryTag)
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of andTags) {
    const key = tagKey(raw)
    if (key === '' || key === primary || seen.has(key)) continue
    seen.add(key)
    result.push(raw.trim())
  }
  return result
}

/** The full AND set a saved search records: primary first, extras after. */
export function fullTagSelection(primaryTag: string, andTags: readonly string[]): string[] {
  return [primaryTag.trim(), ...sanitizeAndTags(primaryTag, andTags)]
}

/**
 * Whether a saved search's tag list is the selection currently on screen.
 * Order-insensitive for the extras, since click order is not meaningful.
 */
export function sameTagSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].map(tagKey).sort()
  const sortedB = [...b].map(tagKey).sort()
  return sortedA.every((value, index) => value === sortedB[index])
}
