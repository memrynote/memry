/**
 * Pure search filtering for the tag hub. No React.
 *
 * A category survives if its name matches or any of its tags match. When the
 * category name matches, every tag is kept; otherwise only the matching tags
 * are kept. Uncategorized is filtered by tag name only. Matching is
 * case-insensitive.
 */
import type { HubState } from '@/components/tags-hub/reorder'
import type { HubTag } from '@/hooks/use-tag-categories'

function matchesTag(tag: HubTag, needle: string): boolean {
  return tag.tag.toLowerCase().includes(needle)
}

export function filterHub(state: HubState, query: string): HubState {
  const needle = query.trim().toLowerCase()
  if (!needle) return state

  const categories = state.categories
    .map((category) => {
      const nameMatches = category.name.toLowerCase().includes(needle)
      const tags = nameMatches ? category.tags : category.tags.filter((t) => matchesTag(t, needle))
      return { ...category, tags }
    })
    .filter((category) => category.tags.length > 0 || category.name.toLowerCase().includes(needle))

  const uncategorized = state.uncategorized.filter((t) => matchesTag(t, needle))

  return { categories, uncategorized }
}
