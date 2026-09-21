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

import {
  getAgentPreferences,
  getAlwaysAllowedTools,
  grantAlwaysAllowedTool,
  revokeAlwaysAllowedTool,
  setAgentPreferences
} from './settings'

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

describe('vault-scoped standing approvals', () => {
  beforeEach(() => {
    storeState.agent = {}
  })

  it('starts with nothing always allowed', () => {
    expect(getAlwaysAllowedTools('vault-1')).toEqual([])
  })

  it('grants and revokes a tool without disturbing the rest of the list', () => {
    grantAlwaysAllowedTool('vault-1', 'vault_create_task')
    grantAlwaysAllowedTool('vault-1', 'vault_update_task')

    expect(getAlwaysAllowedTools('vault-1')).toEqual(['vault_create_task', 'vault_update_task'])

    expect(revokeAlwaysAllowedTool('vault-1', 'vault_create_task')).toEqual(['vault_update_task'])
    expect(getAlwaysAllowedTools('vault-1')).toEqual(['vault_update_task'])
  })

  it('grants the same tool once', () => {
    grantAlwaysAllowedTool('vault-1', 'vault_create_task')
    grantAlwaysAllowedTool('vault-1', 'vault_create_task')

    expect(getAlwaysAllowedTools('vault-1')).toEqual(['vault_create_task'])
  })

  it('ignores a revoke for a tool that was never granted', () => {
    grantAlwaysAllowedTool('vault-1', 'vault_create_task')

    expect(revokeAlwaysAllowedTool('vault-1', 'vault_update_task')).toEqual(['vault_create_task'])
  })

  /**
   * This file is machine-local and outlives a vault switch. A grant made in one
   * vault applying to the next one opened would hand an agent a standing
   * approval over notes the user never showed it.
   */
  it("keeps one vault's grants out of another", () => {
    grantAlwaysAllowedTool('vault-1', 'vault_create_task')

    expect(getAlwaysAllowedTools('vault-2')).toEqual([])

    grantAlwaysAllowedTool('vault-2', 'vault_update_task')

    expect(getAlwaysAllowedTools('vault-1')).toEqual(['vault_create_task'])
    expect(getAlwaysAllowedTools('vault-2')).toEqual(['vault_update_task'])
  })

  it('leaves the other agent preferences alone', () => {
    setAgentPreferences({ toolApprovalMode: 'always_accept' })
    grantAlwaysAllowedTool('vault-1', 'vault_create_task')

    expect(getAgentPreferences().toolApprovalMode).toBe('always_accept')
    expect(getAlwaysAllowedTools('vault-1')).toEqual(['vault_create_task'])
  })
})
