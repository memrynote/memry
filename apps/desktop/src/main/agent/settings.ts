import {
  AgentPreferencesSchema,
  AgentPreferencesUpdateSchema,
  type AgentPreferences,
  type AgentPreferencesUpdate
} from '@memry/contracts/ipc-agent'

import { store } from '../store'

const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  accessMode: 'vault_only',
  toolApprovalMode: 'ask'
}

export function getAgentPreferences(): AgentPreferences {
  const agent = store.get('agent')
  return AgentPreferencesSchema.parse({
    ...DEFAULT_AGENT_PREFERENCES,
    accessMode: agent.accessMode,
    toolApprovalMode: agent.toolApprovalMode
  })
}

/**
 * Tools carrying a standing, vault-scoped approval.
 *
 * Deletes are never in here: the gate refuses to trust a destructive tool
 * whatever the list says, so a stale entry from an older build cannot turn
 * into a silent delete.
 */
export function getAlwaysAllowedTools(vaultId: string): string[] {
  return store.get('agent').alwaysAllowedTools?.[vaultId] ?? []
}

export function grantAlwaysAllowedTool(vaultId: string, toolName: string): string[] {
  const current = getAlwaysAllowedTools(vaultId)
  if (current.includes(toolName)) return current
  return writeAlwaysAllowedTools(vaultId, [...current, toolName])
}

export function revokeAlwaysAllowedTool(vaultId: string, toolName: string): string[] {
  const current = getAlwaysAllowedTools(vaultId)
  if (!current.includes(toolName)) return current
  return writeAlwaysAllowedTools(
    vaultId,
    current.filter((entry) => entry !== toolName)
  )
}

function writeAlwaysAllowedTools(vaultId: string, tools: string[]): string[] {
  const agent = store.get('agent')
  store.set('agent', {
    ...agent,
    alwaysAllowedTools: { ...agent.alwaysAllowedTools, [vaultId]: tools }
  })
  return tools
}

export function setAgentPreferences(input: AgentPreferencesUpdate): AgentPreferences {
  const update = AgentPreferencesUpdateSchema.parse(input)
  store.set('agent', {
    ...store.get('agent'),
    ...update
  })
  return getAgentPreferences()
}
