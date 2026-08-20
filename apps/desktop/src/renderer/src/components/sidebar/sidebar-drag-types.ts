/**
 * Drag payload types for the sidebar's dnd-kit sortables.
 *
 * The sidebar shares one DndContext with the tasks board, so "what is being
 * dragged" has to be stated rather than inferred. Before these existed the
 * project reorder keyed on `data.type === undefined`, which matched every
 * untyped sortable — including bookmarks — and mis-routed their drops.
 */
export const PROJECT_SORT_DRAG_TYPE = 'project-sort' as const
export const BOOKMARK_SORT_DRAG_TYPE = 'bookmark-sort' as const

export interface ProjectReorderTarget {
  from: number
  to: number
}

/**
 * Resolves a finished drag into a project reorder, or null if it is not one.
 *
 * Kept pure and separate because this is exactly where the reorder was broken:
 * a project row registers a sortable (`<id>`) AND a task drop target
 * (`project-<id>`), and dnd-kit may resolve `over` to either. Matching only the
 * bare id silently produced "no reorder", and the drop then fell through to the
 * task-move path, which reported moving zero tasks.
 */
export function resolveProjectReorderTarget(input: {
  activeType: unknown
  activeId: string
  overId: string
  projectIds: readonly string[]
}): ProjectReorderTarget | null {
  if (input.activeType !== PROJECT_SORT_DRAG_TYPE) return null
  if (input.activeId === input.overId) return null

  const from = input.projectIds.indexOf(input.activeId)

  // Direct match first. A project id may itself begin with "project-", so
  // stripping the drop-target prefix unconditionally would mangle it into an id
  // that matches nothing.
  const direct = input.projectIds.indexOf(input.overId)
  const to =
    direct !== -1 ? direct : input.projectIds.indexOf(input.overId.replace(/^project-/, ''))

  if (from === -1 || to === -1 || from === to) return null

  return { from, to }
}
