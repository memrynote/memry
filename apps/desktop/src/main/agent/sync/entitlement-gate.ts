import { TERMINAL_STATUSES, type MessageStatus } from '../storage/types'

export type AgentSyncItemType = 'agent_conversation' | 'agent_message'

export interface AgentSyncEnqueueRequest {
  type: AgentSyncItemType
  id: string
  status?: MessageStatus
}

export interface AgentSyncEntitlementGate {
  maybeEnqueue(req: AgentSyncEnqueueRequest): Promise<void>
}

interface Deps {
  isPaid: () => boolean
  enqueue: (req: AgentSyncEnqueueRequest) => void | Promise<void>
}

export function createAgentSyncEntitlementGate(deps: Deps): AgentSyncEntitlementGate {
  return {
    async maybeEnqueue(req) {
      if (!deps.isPaid()) return
      if (req.type === 'agent_message' && req.status && !TERMINAL_STATUSES.has(req.status)) {
        return
      }
      await deps.enqueue(req)
    }
  }
}
