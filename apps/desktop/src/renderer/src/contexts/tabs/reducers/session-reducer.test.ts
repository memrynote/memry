import { describe, it, expect } from 'vitest'
import { sessionReducer } from './session-reducer'
import { createInitialState } from '../helpers'
import type { TabSystemState } from '../types'

/** Initial state with a single known tab carrying the given `viewState`. */
function stateWithViewState(viewState?: Record<string, unknown>): {
  state: TabSystemState
  groupId: string
  tabId: string
} {
  const base = createInitialState()
  const groupId = Object.keys(base.tabGroups)[0]
  const group = base.tabGroups[groupId]
  const tabId = group.tabs[0].id

  return {
    state: {
      ...base,
      tabGroups: {
        ...base.tabGroups,
        [groupId]: {
          ...group,
          tabs: group.tabs.map((t) => (t.id === tabId ? { ...t, viewState } : t))
        }
      }
    },
    groupId,
    tabId
  }
}

function readTab(
  state: TabSystemState,
  groupId: string,
  tabId: string
): TabSystemState['tabGroups'][string]['tabs'][number] {
  const tab = state.tabGroups[groupId].tabs.find((t) => t.id === tabId)
  if (!tab) throw new Error(`tab ${tabId} missing`)
  return tab
}

describe('sessionReducer SAVE_TAB_STATE viewState merge', () => {
  it('preserves keys the incoming patch does not mention', () => {
    const { state, groupId, tabId } = stateWithViewState({ filter: 'open', sort: 'due' })

    const next = sessionReducer(state, {
      type: 'SAVE_TAB_STATE',
      payload: { tabId, groupId, viewState: { sort: 'created' } }
    })

    expect(readTab(next, groupId, tabId).viewState).toEqual({
      filter: 'open',
      sort: 'created'
    })
  })

  it('deletes a key whose incoming value is undefined', () => {
    const { state, groupId, tabId } = stateWithViewState({ filter: 'open', sort: 'due' })

    const next = sessionReducer(state, {
      type: 'SAVE_TAB_STATE',
      payload: { tabId, groupId, viewState: { filter: undefined } }
    })

    const viewState = readTab(next, groupId, tabId).viewState
    expect(viewState).toEqual({ sort: 'due' })
    expect(viewState && 'filter' in viewState).toBe(false)
  })

  it('seeds viewState when the tab had none', () => {
    const { state, groupId, tabId } = stateWithViewState(undefined)

    const next = sessionReducer(state, {
      type: 'SAVE_TAB_STATE',
      payload: { tabId, groupId, viewState: { mode: 'preview' } }
    })

    expect(readTab(next, groupId, tabId).viewState).toEqual({ mode: 'preview' })
  })

  it('does not mutate the previous viewState object', () => {
    const previous = { filter: 'open' }
    const { state, groupId, tabId } = stateWithViewState(previous)

    sessionReducer(state, {
      type: 'SAVE_TAB_STATE',
      payload: { tabId, groupId, viewState: { filter: 'done' } }
    })

    expect(previous).toEqual({ filter: 'open' })
  })

  it('is a no-op for an unknown groupId', () => {
    const { state, tabId } = stateWithViewState({ filter: 'open' })

    const next = sessionReducer(state, {
      type: 'SAVE_TAB_STATE',
      payload: { tabId, groupId: 'group-that-does-not-exist', viewState: { filter: 'done' } }
    })

    expect(next).toBe(state)
  })
})

describe('sessionReducer UPDATE_SETTINGS', () => {
  it('returns the same state object when the payload changes nothing', () => {
    const state = createInitialState()

    // settings:changed echoes back to the window that performed the write
    // (#1063), so the tabs context re-receives the value it already holds.
    const next = sessionReducer(state, {
      type: 'UPDATE_SETTINGS',
      payload: { ...state.settings }
    })

    expect(next).toBe(state)
    expect(next.settings).toBe(state.settings)
  })

  it('returns the same state object for an empty payload', () => {
    const state = createInitialState()

    expect(sessionReducer(state, { type: 'UPDATE_SETTINGS', payload: {} })).toBe(state)
  })

  it('produces new state when a setting actually changes', () => {
    const state = createInitialState()
    const flipped = !state.settings.restoreSessionOnStart

    const next = sessionReducer(state, {
      type: 'UPDATE_SETTINGS',
      payload: { restoreSessionOnStart: flipped }
    })

    expect(next).not.toBe(state)
    expect(next.settings.restoreSessionOnStart).toBe(flipped)
  })

  it('preserves settings the payload does not mention', () => {
    const state = createInitialState()

    const next = sessionReducer(state, {
      type: 'UPDATE_SETTINGS',
      payload: { tabCloseButton: 'hover' }
    })

    expect(next.settings.tabCloseButton).toBe('hover')
    expect(next.settings.restoreSessionOnStart).toBe(state.settings.restoreSessionOnStart)
  })

  it('leaves the rest of the tab system untouched on a no-op update', () => {
    const state = createInitialState()

    const next = sessionReducer(state, {
      type: 'UPDATE_SETTINGS',
      payload: { ...state.settings }
    })

    expect(next.tabGroups).toBe(state.tabGroups)
    expect(next.layout).toBe(state.layout)
  })
})
