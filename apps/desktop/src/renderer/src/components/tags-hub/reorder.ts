/**
 * Pure ordering arithmetic for the tag hub's drag-and-drop.
 *
 * No React, no dnd-kit — these two functions take the hub's current shape
 * plus a requested move and return the rows whose (categoryId, sortOrder)
 * actually changed, renumbered contiguously from zero. Callers (the page's
 * `onDragEnd`) pass the result straight to `useTagCategories().reorder()`.
 */
import type { HubCategory, HubTag } from '@/hooks/use-tag-categories'
import type { TagAssignment } from '@/services/tags-service'

export interface HubState {
  categories: HubCategory[]
  uncategorized: HubTag[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function bucketFor(state: HubState, categoryId: string | null): HubTag[] {
  if (categoryId === null) return state.uncategorized
  return state.categories.find((c) => c.id === categoryId)?.tags ?? []
}

/**
 * Moves `tag` to `toCategoryId` at `toIndex` (within-category reorder when
 * `toCategoryId` matches the tag's current category). Returns every row
 * whose categoryId or sortOrder changed, with each touched list renumbered
 * contiguously from zero.
 */
export function moveTag(
  state: HubState,
  tag: string,
  toCategoryId: string | null,
  toIndex: number
): TagAssignment[] {
  // Snapshot every tag's current (categoryId, sortOrder) so moved/shifted
  // rows can be detected by comparing against this original position.
  const originalPositions = new Map<string, { categoryId: string | null; sortOrder: number }>()
  for (const category of state.categories) {
    for (const t of category.tags) {
      originalPositions.set(t.tag, { categoryId: category.id, sortOrder: t.sortOrder })
    }
  }
  for (const t of state.uncategorized) {
    originalPositions.set(t.tag, { categoryId: null, sortOrder: t.sortOrder })
  }

  const original = originalPositions.get(tag)
  if (!original) return []

  const fromCategoryId = original.categoryId
  const movedTag = bucketFor(state, fromCategoryId).find((t) => t.tag === tag)
  if (!movedTag) return []

  const results: TagAssignment[] = []

  const renumber = (list: HubTag[], categoryId: string | null): void => {
    list.forEach((t, index) => {
      const prev = originalPositions.get(t.tag)
      if (!prev || prev.categoryId !== categoryId || prev.sortOrder !== index) {
        results.push({ tag: t.tag, categoryId, sortOrder: index })
      }
    })
  }

  if (fromCategoryId === toCategoryId) {
    const list = bucketFor(state, fromCategoryId).filter((t) => t.tag !== tag)
    const index = clamp(toIndex, 0, list.length)
    list.splice(index, 0, movedTag)
    renumber(list, fromCategoryId)
  } else {
    const sourceList = bucketFor(state, fromCategoryId).filter((t) => t.tag !== tag)
    renumber(sourceList, fromCategoryId)

    const destList = bucketFor(state, toCategoryId).slice()
    const index = clamp(toIndex, 0, destList.length)
    destList.splice(index, 0, movedTag)
    renumber(destList, toCategoryId)
  }

  return results
}

/**
 * Moves the category at `fromIndex` to `toIndex`. Returns every category
 * whose sortOrder changed, renumbered contiguously from zero.
 */
export function moveCategory(
  categories: HubCategory[],
  fromIndex: number,
  toIndex: number
): { id: string; sortOrder: number }[] {
  if (
    fromIndex < 0 ||
    fromIndex >= categories.length ||
    toIndex < 0 ||
    toIndex >= categories.length ||
    fromIndex === toIndex
  ) {
    return []
  }

  const reordered = categories.slice()
  const [moved] = reordered.splice(fromIndex, 1)
  reordered.splice(toIndex, 0, moved)

  const results: { id: string; sortOrder: number }[] = []
  reordered.forEach((category, index) => {
    if (category.sortOrder !== index) {
      results.push({ id: category.id, sortOrder: index })
    }
  })
  return results
}

/**
 * Applies a `moveCategory` result onto `categories` for optimistic
 * rendering: re-sorts by the new sortOrder without waiting on the
 * round-trip through `reorder()`.
 */
export function applyCategoryOrder(
  categories: HubCategory[],
  order: { id: string; sortOrder: number }[]
): HubCategory[] {
  if (order.length === 0) return categories
  const nextSortOrder = new Map(order.map((o) => [o.id, o.sortOrder]))
  return categories
    .map((c) => (nextSortOrder.has(c.id) ? { ...c, sortOrder: nextSortOrder.get(c.id)! } : c))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * Applies a `moveTag` result onto `categories`/`uncategorized` for
 * optimistic rendering: moves each touched tag to its new bucket and
 * sortOrder without waiting on the round-trip through `reorder()`.
 */
export function applyTagAssignments(
  categories: HubCategory[],
  uncategorized: HubTag[],
  assignments: TagAssignment[]
): { categories: HubCategory[]; uncategorized: HubTag[] } {
  if (assignments.length === 0) return { categories, uncategorized }

  const assignmentByTag = new Map(assignments.map((a) => [a.tag, a]))
  const originalByTag = new Map<string, HubTag>()
  for (const category of categories) {
    for (const t of category.tags) originalByTag.set(t.tag, t)
  }
  for (const t of uncategorized) originalByTag.set(t.tag, t)

  // Drop touched tags from wherever they currently sit, then re-insert them
  // at their assigned category/sortOrder below.
  const buckets = new Map<string | null, HubTag[]>()
  for (const category of categories) {
    buckets.set(
      category.id,
      category.tags.filter((t) => !assignmentByTag.has(t.tag))
    )
  }
  buckets.set(
    null,
    uncategorized.filter((t) => !assignmentByTag.has(t.tag))
  )

  for (const assignment of assignments) {
    const original = originalByTag.get(assignment.tag)
    if (!original) continue
    const list = buckets.get(assignment.categoryId) ?? []
    list.push({ ...original, sortOrder: assignment.sortOrder })
    buckets.set(assignment.categoryId, list)
  }

  const byOrder = (list: HubTag[]): HubTag[] => [...list].sort((a, b) => a.sortOrder - b.sortOrder)

  return {
    categories: categories.map((c) => ({ ...c, tags: byOrder(buckets.get(c.id) ?? c.tags) })),
    uncategorized: byOrder(buckets.get(null) ?? uncategorized)
  }
}
