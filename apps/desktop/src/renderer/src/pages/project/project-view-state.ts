import type { ProjectTabKey } from './use-project-hub'

export const PROJECT_TAB_KEYS: ProjectTabKey[] = ['overview', 'tasks', 'notes', 'files', 'events']

/**
 * The details rail is built and wired, but we are not showing it to users yet.
 * Hidden behind one flag — the rail, its tab-bar toggle, and the remembered
 * open/closed state all stay in place, so bringing it back is a single edit.
 */
export const PROJECT_RAIL_VISIBLE = false

/**
 * Names inside `Tab.viewState`. Load-bearing for sessions already on disk: the
 * hub has persisted both under exactly these names for a while, so a rename
 * here would silently reset every open project tab on upgrade.
 */
export const PROJECT_VIEW_STATE_KEYS = {
  /** Which sub-tab is showing. */
  projectTab: 'projectTab',
  /** Whether the details rail is expanded. */
  railOpen: 'railOpen'
} as const

/**
 * The hub's sub-tabs each own a scroller and a tab holds ONE scroll record, so
 * every pane stamps which one it is — otherwise opening Files would drop the
 * Overview's offset onto it. `tasks` is absent on purpose: that sub-tab has no
 * wrapper and scrolls inside `VirtualizedProjectTaskList`, which is wired
 * separately under `PROJECT_TASKS_SCROLL_KEY`.
 */
export const PROJECT_SCROLL_KEYS = {
  overview: 'project-overview',
  notes: 'project-notes',
  files: 'project-files',
  events: 'project-events',
  rail: 'project-rail'
} as const

/**
 * `Tab.viewState` is `Record<string, unknown>` and survives session restore, so
 * anything read out of it may be missing, stale, or a value written by a build
 * that spelled the tabs differently. Every reader here is total: an
 * unrecognised value returns `undefined` and the caller falls back.
 */
export const parseProjectTab = (raw: unknown): ProjectTabKey | undefined =>
  typeof raw === 'string' && (PROJECT_TAB_KEYS as string[]).includes(raw)
    ? (raw as ProjectTabKey)
    : undefined

export const parseRailOpen = (raw: unknown): boolean | undefined =>
  typeof raw === 'boolean' ? raw : undefined

/** Defaults, shared by the hook and by the whole-record readers below. */
export const DEFAULT_PROJECT_TAB: ProjectTabKey = 'overview'
export const DEFAULT_RAIL_OPEN = true

export function readProjectTab(viewState: Record<string, unknown> | undefined): ProjectTabKey {
  return parseProjectTab(viewState?.[PROJECT_VIEW_STATE_KEYS.projectTab]) ?? DEFAULT_PROJECT_TAB
}

export function readRailOpen(viewState: Record<string, unknown> | undefined): boolean {
  return parseRailOpen(viewState?.[PROJECT_VIEW_STATE_KEYS.railOpen]) ?? DEFAULT_RAIL_OPEN
}
