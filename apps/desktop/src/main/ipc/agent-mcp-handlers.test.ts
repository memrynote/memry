import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockElectron } from '@tests/utils/mock-electron'

const lazyServicesMock = vi.hoisted(() => ({
  getLazyAgentMcpStatus: vi.fn(async () => ({
    url: 'http://127.0.0.1:1234',
    ['token']: 'local-token-placeholder',
    toolCount: 20
  })),
  rotateLazyAgentMcpToken: vi.fn(async () => ({
    url: 'http://127.0.0.1:1234',
    ['token']: 'rotated-token-placeholder',
    toolCount: 20
  }))
}))

vi.mock('electron', () => ({
  ipcMain: mockElectron.ipcMain
}))

vi.mock('../agent/lazy-services', () => ({
  getLazyAgentMcpStatus: lazyServicesMock.getLazyAgentMcpStatus,
  rotateLazyAgentMcpToken: lazyServicesMock.rotateLazyAgentMcpToken
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

    await expect(findHandler(AgentMcpChannels.invoke.GET_STATUS)()).resolves.toEqual({
      url: 'http://127.0.0.1:1234',
      ['token']: 'local-token-placeholder',
      toolCount: 20
    })
  })

  it('rotates the token and returns refreshed public status', async () => {
    registerAgentMcpHandlers()

    await expect(findHandler(AgentMcpChannels.invoke.ROTATE_TOKEN)()).resolves.toEqual({
      url: 'http://127.0.0.1:1234',
      ['token']: 'rotated-token-placeholder',
      toolCount: 20
    })
    expect(lazyServicesMock.rotateLazyAgentMcpToken).toHaveBeenCalledTimes(1)
  })
})
