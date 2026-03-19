import type { TabAction, TabSystemState } from './types'
import {
  tabCrudReducer,
  tabNavReducer,
  tabModifyReducer,
  tabReorderReducer,
  layoutReducer,
  sessionReducer
} from './reducers'

export function tabReducer(state: TabSystemState, action: TabAction): TabSystemState {
  switch (action.type) {
    case 'OPEN_TAB':
    case 'CLOSE_TAB':
    case 'CLOSE_OTHER_TABS':
    case 'CLOSE_TABS_TO_RIGHT':
    case 'CLOSE_ALL_TABS':
    case 'CLOSE_GROUP':
      return tabCrudReducer(state, action)

    case 'SET_ACTIVE_TAB':
    case 'SET_ACTIVE_GROUP':
    case 'GO_TO_NEXT_TAB':
    case 'GO_TO_PREVIOUS_TAB':
    case 'GO_TO_TAB_INDEX':
      return tabNavReducer(state, action)

    case 'PIN_TAB':
    case 'UNPIN_TAB':
    case 'SET_TAB_MODIFIED':
    case 'SET_TAB_DELETED':
    case 'UPDATE_TAB_TITLE':
    case 'PROMOTE_PREVIEW_TAB':
      return tabModifyReducer(state, action)

    case 'REORDER_TABS':
    case 'MOVE_TAB':
      return tabReorderReducer(state, action)

    case 'SPLIT_VIEW':
    case 'RESIZE_SPLIT':
    case 'CLOSE_SPLIT':
    case 'MOVE_TAB_TO_NEW_SPLIT':
    case 'SET_LAYOUT':
      return layoutReducer(state, action)

    case 'SAVE_TAB_STATE':
    case 'UPDATE_SETTINGS':
    case 'RESTORE_SESSION':
    case 'RESET_TO_DEFAULT':
      return sessionReducer(state, action)

    default:
      return state
  }
}
