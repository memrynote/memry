/**
 * Tag categories as the graph sees them: an ordered list with a palette slot
 * each, and a tag -> category lookup.
 *
 * Tag categories carry no colour of their own, so each gets a slot in the
 * `--graph-group-*` palette by its position in the category order. Past eight
 * categories the palette repeats; the legend's labels keep them apart.
 */

import { tagOfTagNode } from './graph-builder'

export const GRAPH_GROUP_PALETTE_SIZE = 8

export const graphGroupColorVar = (index: number): string =>
  `--graph-group-${(index % GRAPH_GROUP_PALETTE_SIZE) + 1}`

export const GRAPH_GROUP_NONE_VAR = '--graph-group-none'

export interface GraphCategory {
  id: string
  label: string
  colorVar: string
  tags: string[]
}

export interface GraphCategoryIndex {
  categories: GraphCategory[]
  /** Tag -> position of its category in `categories`. */
  rankByTag: Map<string, number>
}

export function buildGraphCategoryIndex(
  categories: ReadonlyArray<{ id: string; name: string; tags: ReadonlyArray<{ tag: string }> }>
): GraphCategoryIndex {
  const rankByTag = new Map<string, number>()
  const graphCategories = categories.map((category, index) => {
    const tags = category.tags.map((entry) => entry.tag)
    for (const tag of tags) {
      if (!rankByTag.has(tag)) rankByTag.set(tag, index)
    }
    return { id: category.id, label: category.name, colorVar: graphGroupColorVar(index), tags }
  })
  return { categories: graphCategories, rankByTag }
}

/**
 * The category a node belongs to: the first one, in category order, that any
 * of its tags falls in. A `tag:<name>` node belongs to its own tag's category.
 */
export function categoryRankOf(
  nodeId: string,
  tags: readonly string[] | undefined,
  rankByTag: Map<string, number>
): number | undefined {
  const ownTag = tagOfTagNode(nodeId)
  let rank: number | undefined
  for (const tag of ownTag !== null ? [ownTag] : (tags ?? [])) {
    const candidate = rankByTag.get(tag)
    if (candidate !== undefined && (rank === undefined || candidate < rank)) rank = candidate
  }
  return rank
}
