import { ipcMain } from 'electron'

import { AgentMcpChannels, type AgentMcpStatus } from '@memry/contracts/agent-mcp-channels'
import { getPublicStatus, rotateToken } from '../agent/mcp/lifecycle'

export function registerAgentMcpHandlers(): void {
  ipcMain.handle(AgentMcpChannels.invoke.GET_STATUS, (): AgentMcpStatus => getPublicStatus())
  ipcMain.handle(AgentMcpChannels.invoke.ROTATE_TOKEN, (): AgentMcpStatus => {
    rotateToken()
    return getPublicStatus()
  })
}

export function unregisterAgentMcpHandlers(): void {
  ipcMain.removeHandler(AgentMcpChannels.invoke.GET_STATUS)
  ipcMain.removeHandler(AgentMcpChannels.invoke.ROTATE_TOKEN)
}
