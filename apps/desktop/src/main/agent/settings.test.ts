import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  agent: {} as Record<string, unknown>
}))

vi.mock('../store', () => ({
  store: {
    get: vi.fn((key: string) => {
      if (key === 'agent') return storeState.agent
      return undefined
    }),
    set: vi.fn((key: string, value: unknown) => {
      if (key === 'agent') storeState.agent = value as Record<string, unknown>
    })
  }
}))

import { getAgentPreferences, setAgentPreferences } from './settings'

describe('agent preferences', () => {
  beforeEach(() => {
    storeState.agent = {}
  })

  it('defaults tool approval to always accept', () => {
    expect(getAgentPreferences()).toEqual({ toolApprovalMode: 'always_accept' })
  })

  it('persists manual tool approval mode', () => {
    expect(setAgentPreferences({ toolApprovalMode: 'ask' })).toEqual({
      toolApprovalMode: 'ask'
    })
    expect(getAgentPreferences()).toEqual({ toolApprovalMode: 'ask' })
  })

  it('keeps the current preference when an empty update is saved', () => {
    setAgentPreferences({ toolApprovalMode: 'ask' })

    expect(setAgentPreferences({})).toEqual({ toolApprovalMode: 'ask' })
  })
})
