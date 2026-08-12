import type { TabAction, TabSystemState } from '../types'
import { createInitialState } from '../helpers'
import { mergeSettingsPatch } from '@/lib/settings-patch'

type SessionAction = Extract<
  TabAction,
  { type: 'UPDATE_SETTINGS' | 'RESTORE_SESSION' | 'RESET_TO_DEFAULT' | 'SAVE_TAB_STATE' }
>

export function sessionReducer(state: TabSystemState, action: SessionAction): TabSystemState {
  switch (action.type) {
    case 'SAVE_TAB_STATE': {
      const { tabId, groupId, scrollPosition, viewState } = action.payload
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
                    ...(viewState !== undefined && { viewState })
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
