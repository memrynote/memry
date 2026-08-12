import { describe, it, expect } from 'vitest'
import { sessionReducer } from './session-reducer'
import { createInitialState } from '../helpers'

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
