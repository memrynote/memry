import type { TabAction, TabSystemState } from '../types'
import { createInitialState } from '../helpers'

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
      return { ...state, settings: { ...state.settings, ...action.payload } }
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
