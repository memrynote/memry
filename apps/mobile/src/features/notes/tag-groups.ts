export interface TagGroup {
  /** First path segment, first-seen casing. `null` for tags outside any category. */
  category: string | null
  /** Full tag names, in the order they arrived. */
  tags: string[]
}

/** Local copy of `normalizeTagKey`, so grouping stays free of the db module. */
function key(tag: string): string {
  return tag.trim().toLowerCase()
}

/**
 * Split a flat tag list into the categories the desktop sidebar draws.
 *
 * Desktop nests tags on `/` (see the renderer's `lib/tag-tree.ts`). The sheet
 * only needs the top level: a vault with hundreds of tags becomes browsable
 * once `work/clients/acme` sits under WORK, and a deeper tree inside a bottom
 * sheet would cost taps without buying reachability.
 *
 * A tag that IS a category — `work` next to `work/clients` — joins its own
 * category rather than the loose list, which is exactly the split the flat
 * chip cloud used to show.
 */
export function groupTagsByCategory(tags: string[]): TagGroup[] {
  const categories = new Map<string, string>()
  for (const tag of tags) {
    const slash = tag.indexOf('/')
    if (slash > 0) {
      const category = tag.slice(0, slash)
      if (!categories.has(key(category))) categories.set(key(category), category)
    }
  }

  const loose: string[] = []
  const grouped = new Map<string, TagGroup>()
  for (const tag of tags) {
    const slash = tag.indexOf('/')
    const categoryKey = slash > 0 ? key(tag.slice(0, slash)) : key(tag)
    const category = categories.get(categoryKey)
    if (!category) {
      loose.push(tag)
      continue
    }
    let group = grouped.get(categoryKey)
    if (!group) {
      group = { category, tags: [] }
      grouped.set(categoryKey, group)
    }
    group.tags.push(tag)
  }

  const groups = [...grouped.values()].sort((a, b) =>
    (a.category ?? '').localeCompare(b.category ?? '')
  )
  return loose.length > 0 ? [{ category: null, tags: loose }, ...groups] : groups
}

/**
 * What the chip shows inside its group: the tail, since the header already
 * carries the category. A tag that IS the category keeps its whole name.
 */
export function tagLabelInGroup(tag: string, category: string | null): string {
  if (category === null) return tag
  const prefix = `${category}/`
  return key(tag).startsWith(key(prefix)) ? tag.slice(prefix.length) : tag
}
