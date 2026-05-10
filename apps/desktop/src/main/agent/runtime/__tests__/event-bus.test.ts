import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockElectron, MockBrowserWindow } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  BrowserWindow: mockElectron.BrowserWindow
}))

import { AgentChannels, type AgentEvent } from '@memry/contracts/ipc-agent'

import { broadcastAgentEvent } from '../event-bus'

describe('broadcastAgentEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockBrowserWindow.getAllWindows.mockReturnValue([])
  })

  it('sends agent events to every live window', () => {
    const first = new MockBrowserWindow()
    const second = new MockBrowserWindow()
    const event: AgentEvent = {
      kind: 'assistant_text_delta',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      text: 'hello'
    }
    MockBrowserWindow.getAllWindows.mockReturnValue([first, second] as never)

    broadcastAgentEvent(event)

    expect(first.webContents.send).toHaveBeenCalledWith(AgentChannels.events.AGENT_EVENT, event)
    expect(second.webContents.send).toHaveBeenCalledWith(AgentChannels.events.AGENT_EVENT, event)
  })

  it('skips destroyed windows', () => {
    const destroyed = new MockBrowserWindow()
    destroyed.destroy()
    const live = new MockBrowserWindow()
    const event: AgentEvent = {
      kind: 'turn_completed',
      conversationId: 'conversation-1',
      turnId: 'turn-1'
    }
    MockBrowserWindow.getAllWindows.mockReturnValue([destroyed, live] as never)

    broadcastAgentEvent(event)

    expect(destroyed.webContents.send).not.toHaveBeenCalled()
    expect(live.webContents.send).toHaveBeenCalledWith(AgentChannels.events.AGENT_EVENT, event)
  })
})
