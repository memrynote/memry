import { AgentChannels, type AgentEvent } from '@memry/contracts/ipc-agent'

import { broadcastToAllWindows } from '../../lib/window-broadcast'

export function broadcastAgentEvent(event: AgentEvent): void {
  broadcastToAllWindows(AgentChannels.events.AGENT_EVENT, event)
}
