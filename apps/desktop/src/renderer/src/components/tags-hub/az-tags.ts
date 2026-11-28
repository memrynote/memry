/**
 * Pure builder for the tag hub's A-Z view. No React.
 *
 * Flattens every category and Uncategorized into one list, drops duplicates,
 * applies the same search as the categories view, and sorts by the user's
 * locale so accents, case and numbers order the way that language expects.
 */
import type { HubState } from '@/components/tags-hub/reorder'
import { filterHub } from '@/components/tags-hub/filter'
import type { HubTag } from '@/hooks/use-tag-categories'

export function buildAzTagList(state: HubState, query: string, locale: string): HubTag[] {
  const unique = new Map<string, HubTag>()
  for (const tag of [...state.categories.flatMap((c) => c.tags), ...state.uncategorized]) {
    if (!unique.has(tag.tag)) unique.set(tag.tag, tag)
  }

  // A tag's name is the only thing the A-Z view shows, so only it is searched
  // (a category name matching must not pull its tags in).
  const { uncategorized: matching } = filterHub(
    { categories: [], uncategorized: [...unique.values()] },
    query
  )

  // Base sensitivity ignores accents and case ("e" = "E" = "é"), and numeric
  // puts "item 2" before "item 10". Tags equal at that level (only the case
  // differs) fall back to the strict collator so the order is deterministic.
  const loose = new Intl.Collator(locale, { sensitivity: 'base', numeric: true })
  const strict = new Intl.Collator(locale, { numeric: true })
  return matching.toSorted((a, b) => loose.compare(a.tag, b.tag) || strict.compare(a.tag, b.tag))
}
