import {
  AgentPreferencesSchema,
  AgentPreferencesUpdateSchema,
  type AgentPreferences,
  type AgentPreferencesUpdate
} from '@memry/contracts/ipc-agent'

import { store } from '../store'

const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  toolApprovalMode: 'always_accept'
}

export function getAgentPreferences(): AgentPreferences {
  const agent = store.get('agent')
  return AgentPreferencesSchema.parse({
    ...DEFAULT_AGENT_PREFERENCES,
    toolApprovalMode: agent.toolApprovalMode
  })
}

export function setAgentPreferences(input: AgentPreferencesUpdate): AgentPreferences {
  const update = AgentPreferencesUpdateSchema.parse(input)
  store.set('agent', {
    ...store.get('agent'),
    ...update
  })
  return getAgentPreferences()
}
