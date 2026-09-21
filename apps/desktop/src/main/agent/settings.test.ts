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

  /**
   * Nothing is written to the store until the user chooses, so this default is
   * the effective value for every install that never visited the setting,
   * including existing ones. It asks rather than accepting, which is the only
   * direction that cannot surprise someone into a silent vault write.
   */
  it('defaults agent permissions to vault access and asking before changes', () => {
    expect(getAgentPreferences()).toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'ask'
    })
  })

  it('persists an explicit choice to accept without asking', () => {
    expect(setAgentPreferences({ toolApprovalMode: 'always_accept' })).toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'always_accept'
    })
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
      toolApprovalMode: 'ask'
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
