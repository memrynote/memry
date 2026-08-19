/**
 * What a Tasks tab remembers, and how it is read back.
 *
 * These keys are load-bearing for sessions that already exist on disk: the page
 * has persisted `activeView`, `activeInternalTab` (with `activeTab` as its
 * older spelling), `selectedProjectId`, `openTaskId` and `focusQuickAddAt` for
 * a while. The names must not change — only the machinery reading them did.
 *
 * Deliberately NOT here, because they are already persisted elsewhere and two
 * stores for one value fight:
 * - filters and sort           → localStorage, `use-task-filters`
 * - expanded subtask rows      → localStorage, `use-expanded-tasks`
 * - saved filters, defaultView → DB / settings
 */

import type { TasksInternalTab } from '@/components/tasks/tasks-tab-bar'
import type { ViewMode } from '@/data/tasks-data'

export const TASKS_VIEW_STATE_KEYS = {
  /** List or kanban. */
  activeView: 'activeView',
  /** All, or one of the due-date windows (today, tomorrow, next7). */
  activeInternalTab: 'activeInternalTab',
  /** Pre-rename spelling of `activeInternalTab`, still written for old builds. */
  activeInternalTabLegacy: 'activeTab',
  /** Project the view is scoped to. `null` means "all projects". */
  selectedProjectId: 'selectedProjectId',
  /** Task open in the detail drawer. */
  openTaskId: 'openTaskId',
  /** Saved filter currently applied. */
  activeSavedFilterId: 'activeSavedFilterId',
  /** Collapsed groups in the all-tasks list. */
  collapsedGroups: 'collapsedTaskGroups',
  /** One-shot nonce written by the sidebar and the empty state, not by this page's state. */
  focusQuickAddAt: 'focusQuickAddAt'
} as const

/**
 * One scroll record per tab, so every list says which one it is. The Today and
 * All lists are the same component with a different `storageKey`, and they
 * scroll independently.
 */
export const tasksScrollKey = (storageKey: string): string => `tasks:${storageKey}`

/** The per-project list, which is a different component in the same tab. */
export const PROJECT_TASKS_SCROLL_KEY = 'tasks-project'

const VIEW_MODES: ViewMode[] = ['list', 'kanban']
// Older builds only knew 'today' and 'all'; they parse the newer window values
// as "nothing stored" and fall back to the default view, which is intended.
const INTERNAL_TABS: TasksInternalTab[] = ['today', 'tomorrow', 'next7', 'all']

/** Groups collapsed by default. `done` starts closed; the rest start open. */
export const DEFAULT_COLLAPSED_GROUPS: string[] = ['done']

export const parseViewMode = (raw: unknown): ViewMode | undefined =>
  typeof raw === 'string' && (VIEW_MODES as string[]).includes(raw) ? (raw as ViewMode) : undefined

export const parseInternalTab = (raw: unknown): TasksInternalTab | undefined =>
  typeof raw === 'string' && (INTERNAL_TABS as string[]).includes(raw)
    ? (raw as TasksInternalTab)
    : undefined

/**
 * `null` is a value — "no project" / "no task open" — and must be told apart
 * from "nothing stored", which falls back to the caller's default.
 */
export const parseNullableId = (raw: unknown): string | null | undefined =>
  raw === null || typeof raw === 'string' ? raw : undefined

export const parseStringArray = (raw: unknown): string[] | undefined =>
  Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : undefined
