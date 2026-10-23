import type { AgentBackendRegistry } from './registry'

let active: AgentBackendRegistry | null = null

/** Set by startAgent for the open vault, cleared on shutdown. */
export function setActiveBackends(registry: AgentBackendRegistry | null): void {
  active = registry
}

export function getActiveBackends(): AgentBackendRegistry | null {
  return active
}
