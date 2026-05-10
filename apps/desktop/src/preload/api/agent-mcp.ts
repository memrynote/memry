import { AgentMcpChannels, type AgentMcpStatus } from '@memry/contracts/agent-mcp-channels'
import { invoke } from '../lib/ipc'

export const agentMcpApi = {
  getStatus: (): Promise<AgentMcpStatus> =>
    invoke<AgentMcpStatus>(AgentMcpChannels.invoke.GET_STATUS),
  ['rotateToken']: (): Promise<AgentMcpStatus> =>
    invoke<AgentMcpStatus>(AgentMcpChannels.invoke.ROTATE_TOKEN)
}
