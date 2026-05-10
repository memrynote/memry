import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockElectron } from '@tests/utils/mock-electron'

const lifecycleMock = vi.hoisted(() => ({
  getPublicStatus: vi.fn(() => ({
    url: 'http://127.0.0.1:1234',
    ['token']: 'local-token-placeholder',
    toolCount: 19
  })),
  ['rotateToken']: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: mockElectron.ipcMain
}))

vi.mock('../agent/mcp/lifecycle', () => ({
  getPublicStatus: lifecycleMock.getPublicStatus,
  ['rotateToken']: lifecycleMock.rotateToken
}))

import { AgentMcpChannels } from '@memry/contracts/agent-mcp-channels'
import { registerAgentMcpHandlers, unregisterAgentMcpHandlers } from './agent-mcp-handlers'

function findHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockElectron.ipcMain.handle.mock.calls.find(([registered]) => registered === channel)
  expect(call).toBeDefined()
  return call![1] as (...args: unknown[]) => unknown
}

describe('agent MCP IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    unregisterAgentMcpHandlers()
  })

  it('registers status and rotate-token handlers', () => {
    registerAgentMcpHandlers()

    expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(
      AgentMcpChannels.invoke.GET_STATUS,
      expect.any(Function)
    )
    expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(
      AgentMcpChannels.invoke.ROTATE_TOKEN,
      expect.any(Function)
    )
  })

  it('returns public status', async () => {
    registerAgentMcpHandlers()

    expect(findHandler(AgentMcpChannels.invoke.GET_STATUS)()).toEqual({
      url: 'http://127.0.0.1:1234',
      ['token']: 'local-token-placeholder',
      toolCount: 19
    })
  })

  it('rotates the token and returns refreshed public status', async () => {
    registerAgentMcpHandlers()

    expect(findHandler(AgentMcpChannels.invoke.ROTATE_TOKEN)()).toEqual({
      url: 'http://127.0.0.1:1234',
      ['token']: 'local-token-placeholder',
      toolCount: 19
    })
    expect(lifecycleMock.rotateToken).toHaveBeenCalledTimes(1)
  })
})
