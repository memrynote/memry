import { ipcMain } from 'electron'

import { AgentMcpChannels, type AgentMcpStatus } from '@memry/contracts/agent-mcp-channels'
import { getLazyAgentMcpStatus, rotateLazyAgentMcpToken } from '../agent/lazy-services'

export function registerAgentMcpHandlers(): void {
  ipcMain.handle(AgentMcpChannels.invoke.GET_STATUS, (): Promise<AgentMcpStatus> => {
    return getLazyAgentMcpStatus()
  })
  ipcMain.handle(AgentMcpChannels.invoke.ROTATE_TOKEN, (): Promise<AgentMcpStatus> => {
    return rotateLazyAgentMcpToken()
  })
}

export function unregisterAgentMcpHandlers(): void {
  ipcMain.removeHandler(AgentMcpChannels.invoke.GET_STATUS)
  ipcMain.removeHandler(AgentMcpChannels.invoke.ROTATE_TOKEN)
}
