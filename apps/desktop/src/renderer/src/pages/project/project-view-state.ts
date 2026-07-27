import type { ProjectTabKey } from './use-project-hub'

export const PROJECT_TAB_KEYS: ProjectTabKey[] = ['overview', 'tasks', 'notes', 'files', 'events']

/**
 * `Tab.viewState` is `Record<string, unknown>` and survives session restore, so
 * anything read out of it may be missing, stale, or a value written by a build
 * that spelled the tabs differently. Both readers are total.
 */
export function readProjectTab(viewState: Record<string, unknown> | undefined): ProjectTabKey {
  const value = viewState?.projectTab
  return typeof value === 'string' && (PROJECT_TAB_KEYS as string[]).includes(value)
    ? (value as ProjectTabKey)
    : 'overview'
}

export function readRailOpen(viewState: Record<string, unknown> | undefined): boolean {
  const value = viewState?.railOpen
  return typeof value === 'boolean' ? value : true
}
