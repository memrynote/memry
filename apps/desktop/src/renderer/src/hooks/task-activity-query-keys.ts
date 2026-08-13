/** How many rows the drawer's inline preview shows before "Show all". */
export const ACTIVITY_PREVIEW_SIZE = 3

/** Page size for the full timeline in the Sheet. */
export const ACTIVITY_PAGE_SIZE = 50

export const taskActivityKeys = {
  all: ['task-activity'] as const,
  lists: () => [...taskActivityKeys.all, 'list'] as const,
  list: (taskId: string, options?: { limit?: number; actions?: string[] }) =>
    [...taskActivityKeys.lists(), taskId, options ?? {}] as const
}
