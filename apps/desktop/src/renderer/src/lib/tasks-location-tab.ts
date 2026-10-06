/**
 * "Show tasks" on a sidebar folder or note: open Tasks filtered to that place.
 *
 * Filters live in localStorage (`use-task-filters`), not on the tab, so the
 * sidebar cannot write them directly. It writes a one-shot request into the
 * Tasks tab's view state instead, and the page applies it to its own filter
 * state. The `requestedAt` nonce lets the same folder be requested twice in a
 * row: the page applies each nonce once.
 */

import type { OpenTargetTab } from '@/hooks/use-open-target'

export const SHOW_TASKS_LOCATION_KEY = 'showTasksLocation'

export interface ShowTasksLocationRequest {
  folderPaths: string[]
  noteIds: string[]
  requestedAt: number
}

const stringArray = (raw: unknown): string[] | null =>
  Array.isArray(raw) && raw.every((value) => typeof value === 'string') ? raw : null

export const parseShowTasksLocation = (raw: unknown): ShowTasksLocationRequest | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const folderPaths = stringArray(record.folderPaths)
  const noteIds = stringArray(record.noteIds)
  if (!folderPaths || !noteIds || typeof record.requestedAt !== 'number') return null
  if (folderPaths.length === 0 && noteIds.length === 0) return null
  return { folderPaths, noteIds, requestedAt: record.requestedAt }
}

export const tasksTabForLocation = (
  location: { folderPath: string } | { noteId: string },
  title: string
): OpenTargetTab => {
  const request: ShowTasksLocationRequest = {
    folderPaths: 'folderPath' in location ? [location.folderPath] : [],
    noteIds: 'noteId' in location ? [location.noteId] : [],
    requestedAt: Date.now()
  }
  return {
    type: 'tasks',
    title,
    icon: 'CheckSquare',
    path: '/tasks',
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false,
    viewState: {
      // Every project and the unwindowed list: a location is the scope here,
      // and a leftover project or due window would hide tasks that live there.
      selectedProjectId: null,
      activeInternalTab: 'all',
      activeTab: 'all',
      [SHOW_TASKS_LOCATION_KEY]: request
    }
  }
}
