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

  it('defaults agent permissions to vault access with automatic confirmations', () => {
    expect(getAgentPreferences()).toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'always_accept'
    })
  })

  it('persists manual tool approval mode', () => {
    expect(setAgentPreferences({ toolApprovalMode: 'ask' })).toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'ask'
    })
    expect(getAgentPreferences()).toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'ask'
    })
  })

  it('persists default access mode', () => {
    expect(setAgentPreferences({ accessMode: 'computer_access' })).toEqual({
      accessMode: 'computer_access',
      toolApprovalMode: 'always_accept'
    })
  })

  it('keeps the current preference when an empty update is saved', () => {
    setAgentPreferences({ toolApprovalMode: 'ask' })

    expect(setAgentPreferences({})).toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'ask'
    })
  })
})
