import { BrowserWindow } from 'electron'

import { AgentChannels, type AgentEvent } from '@memry/contracts/ipc-agent'

export function broadcastAgentEvent(event: AgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(AgentChannels.events.AGENT_EVENT, event)
    }
  }
}
