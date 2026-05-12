import type { AgentBackendId } from '@memry/contracts/ipc-agent'

import type { AgentBackend } from './types'

export interface AgentBackendRegistry {
  get(id: AgentBackendId): AgentBackend
  list(): AgentBackend[]
}

export function createAgentBackendRegistry(input: {
  claude: AgentBackend
  codex: AgentBackend
  local: AgentBackend
}): AgentBackendRegistry {
  const backends = new Map<AgentBackendId, AgentBackend>([
    ['claude_cli', input.claude],
    ['codex_cli', input.codex],
    ['local_openai_compatible', input.local]
  ])

  return {
    get(id) {
      const backend = backends.get(id)
      if (!backend) throw new Error(`Unknown agent backend: ${id}`)
      return backend
    },
    list() {
      return Array.from(backends.values())
    }
  }
}
