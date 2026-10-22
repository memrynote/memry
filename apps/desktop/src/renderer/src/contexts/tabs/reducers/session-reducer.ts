import type { Tab, TabAction, TabScrollPanes, TabSystemState } from '../types'
import { createInitialState } from '../helpers'
import { mergeScrollPanes } from '../scroll-panes'
import { mergeSettingsPatch } from '@/lib/settings-patch'

type SessionAction = Extract<
  TabAction,
  { type: 'UPDATE_SETTINGS' | 'RESTORE_SESSION' | 'RESET_TO_DEFAULT' | 'SAVE_TAB_STATE' }
>

/**
 * Shallow-merge a `viewState` patch over the tab's existing `viewState`.
 *
 * `SAVE_TAB_STATE` used to replace `viewState` wholesale, so two independent
 * writers on the same tab (say a filter control and a scroll-restore hook)
 * clobbered each other depending on which dispatched last. A key whose incoming
 * value is `undefined` is a deletion, which is the only way a caller can drop a
 * key now that writes are merged.
 */
function mergeViewState(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }
  return next
}

/**
 * Keep only the pane entries measured against what the tab shows NOW.
 *
 * A pane tears down AFTER a same-tab navigation (wikilink, back, forward) has
 * already swapped the tab's content, and its final save lands on the incoming
 * entity's tab. All entities share one slot per pane, so that late save would
 * overwrite the entry the swap just restored for the incoming page with the
 * outgoing page's offset, and the page the user returns to would start at the
 * top. The outgoing offset already travels in the history entry the swap pushed.
 */
function ownedBy(tab: Tab, panes: TabScrollPanes): TabScrollPanes {
  return Object.fromEntries(
    Object.entries(panes).filter(([, entry]) => entry.entityId === tab.entityId)
  )
}

export function sessionReducer(state: TabSystemState, action: SessionAction): TabSystemState {
  switch (action.type) {
    case 'SAVE_TAB_STATE': {
      const { tabId, groupId, scrollPosition, scrollState, scrollPanes, viewState } = action.payload
      const group = state.tabGroups[groupId]
      if (!group) return state

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    ...(scrollPosition !== undefined && { scrollPosition }),
                    ...(scrollState !== undefined && { scrollState }),
                    // A patch, not a replacement: panes are independent writers
                    // on the same tab, exactly like `viewState`'s keys.
                    ...(scrollPanes !== undefined && {
                      scrollPanes: mergeScrollPanes(t.scrollPanes, ownedBy(t, scrollPanes))
                    }),
                    ...(viewState !== undefined && {
                      viewState: mergeViewState(t.viewState, viewState)
                    })
                  }
                : t
            )
          }
        }
      }
    }

    case 'UPDATE_SETTINGS': {
      const settings = mergeSettingsPatch(state.settings, action.payload)
      // settings:changed echoes back to the window that wrote it (#1063), so an
      // UPDATE_SETTINGS that changes nothing must not mint a new state object —
      // that would re-render every tab consumer for no reason.
      return settings === state.settings ? state : { ...state, settings }
    }

    case 'RESTORE_SESSION': {
      return action.payload
    }

    case 'RESET_TO_DEFAULT': {
      return createInitialState()
    }

    default:
      return state
  }
}
