import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockElectron, MockBrowserWindow } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  BrowserWindow: mockElectron.BrowserWindow
}))

import { AgentChannels, type AgentEvent } from '@memry/contracts/ipc-agent'

import { broadcastAgentEvent, setAgentStreamTarget } from '../event-bus'

const DELTA: AgentEvent = {
  kind: 'assistant_text_delta',
  conversationId: 'conversation-1',
  messageId: 'message-1',
  text: 'hello'
}

function windowWithId(id: number): MockBrowserWindow {
  const win = new MockBrowserWindow()
  win.id = id
  return win
}

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

  it('sends assistant deltas only to the windows showing that conversation', () => {
    const viewer = windowWithId(11)
    const other = windowWithId(12)
    MockBrowserWindow.getAllWindows.mockReturnValue([viewer, other] as never)
    setAgentStreamTarget(11, 'conversation-1')
    setAgentStreamTarget(12, 'conversation-2')

    broadcastAgentEvent(DELTA)

    expect(viewer.webContents.send).toHaveBeenCalledWith(AgentChannels.events.AGENT_EVENT, DELTA)
    expect(other.webContents.send).not.toHaveBeenCalled()
  })

  it('sends assistant deltas to every window showing the conversation, skipping destroyed ones', () => {
    const secondViewer = windowWithId(21)
    const destroyedViewer = windowWithId(22)
    destroyedViewer.destroy()
    MockBrowserWindow.getAllWindows.mockReturnValue([secondViewer, destroyedViewer] as never)
    setAgentStreamTarget(21, 'conversation-1')
    setAgentStreamTarget(22, 'conversation-1')

    expect(() => broadcastAgentEvent(DELTA)).not.toThrow()

    expect(secondViewer.webContents.send).toHaveBeenCalledWith(
      AgentChannels.events.AGENT_EVENT,
      DELTA
    )
    expect(destroyedViewer.webContents.send).not.toHaveBeenCalled()
  })

  it('drops assistant deltas for a conversation no window shows', () => {
    const idle = windowWithId(31)
    MockBrowserWindow.getAllWindows.mockReturnValue([idle] as never)
    setAgentStreamTarget(31, null)

    broadcastAgentEvent(DELTA)

    expect(idle.webContents.send).not.toHaveBeenCalled()
  })

  it('falls back to every window when no live window has reported a target', () => {
    const first = windowWithId(41)
    const second = windowWithId(42)
    MockBrowserWindow.getAllWindows.mockReturnValue([first, second] as never)
    // Left over from a window that has since closed: it must be forgotten, not
    // counted as "somebody is watching".
    setAgentStreamTarget(999, 'conversation-1')

    broadcastAgentEvent(DELTA)

    expect(first.webContents.send).toHaveBeenCalledWith(AgentChannels.events.AGENT_EVENT, DELTA)
    expect(second.webContents.send).toHaveBeenCalledWith(AgentChannels.events.AGENT_EVENT, DELTA)
  })

  it('still broadcasts non-delta events to windows that show another conversation', () => {
    const viewer = windowWithId(51)
    const other = windowWithId(52)
    MockBrowserWindow.getAllWindows.mockReturnValue([viewer, other] as never)
    setAgentStreamTarget(51, 'conversation-1')
    setAgentStreamTarget(52, 'conversation-2')
    const event: AgentEvent = {
      kind: 'turn_completed',
      conversationId: 'conversation-1',
      turnId: 'turn-1'
    }

    broadcastAgentEvent(event)

    expect(viewer.webContents.send).toHaveBeenCalledWith(AgentChannels.events.AGENT_EVENT, event)
    expect(other.webContents.send).toHaveBeenCalledWith(AgentChannels.events.AGENT_EVENT, event)
  })
})
