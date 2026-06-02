import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configureLazyAgentServices,
  getLazyAgentMcpStatus,
  rotateLazyAgentMcpToken
} from './lazy-services'

const lifecycleMock = vi.hoisted(() => ({
  getPublicStatus: vi.fn(async () => ({
    url: 'http://127.0.0.1:45900/mcp',
    token: 'token-1',
    toolCount: 4
  })),
  rotateToken: vi.fn()
}))

vi.mock('./mcp/lifecycle', () => lifecycleMock)

describe('lazy agent services', () => {
  beforeEach(() => {
    configureLazyAgentServices(null)
    lifecycleMock.getPublicStatus.mockClear()
    lifecycleMock.rotateToken.mockClear()
  })

  it('returns stopped MCP status when no vault starter is configured', async () => {
    await expect(getLazyAgentMcpStatus()).resolves.toEqual({
      url: null,
      token: null,
      toolCount: 0
    })
    expect(lifecycleMock.getPublicStatus).not.toHaveBeenCalled()
  })

  it('starts lazy services before reading MCP status', async () => {
    const starter = vi.fn(async () => undefined)
    configureLazyAgentServices(starter)

    await expect(getLazyAgentMcpStatus()).resolves.toEqual({
      url: 'http://127.0.0.1:45900/mcp',
      token: 'token-1',
      toolCount: 4
    })
    expect(starter).toHaveBeenCalledTimes(1)
    expect(lifecycleMock.getPublicStatus).toHaveBeenCalledTimes(1)
  })

  it('starts lazy services before rotating the MCP token', async () => {
    const starter = vi.fn(async () => undefined)
    configureLazyAgentServices(starter)

    await rotateLazyAgentMcpToken()
    expect(starter).toHaveBeenCalledTimes(1)
    expect(lifecycleMock.rotateToken).toHaveBeenCalledTimes(1)
  })
})
