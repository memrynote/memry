import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPublicStatus: vi.fn(),
  clientConnect: vi.fn(),
  clientCallTool: vi.fn(),
  clientClose: vi.fn(),
  clientCtor: vi.fn(),
  transportCtor: vi.fn()
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function MockClient(...args: unknown[]) {
    mocks.clientCtor(...args)
    return {
      connect: mocks.clientConnect,
      callTool: mocks.clientCallTool,
      close: mocks.clientClose
    }
  })
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function MockStreamableHTTPClientTransport(
    ...args: unknown[]
  ) {
    mocks.transportCtor(...args)
    return { type: 'transport' }
  })
}))

vi.mock('../../mcp/lifecycle', () => ({
  getPublicStatus: mocks.getPublicStatus
}))

import { AgentToolBridge, createAiSdkToolSet } from '../tool-bridge'

describe('AgentToolBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clientConnect.mockResolvedValue(undefined)
    mocks.clientClose.mockResolvedValue(undefined)
    mocks.getPublicStatus.mockReturnValue({
      url: 'http://127.0.0.1:3928',
      token: 'agent-token'
    })
  })

  it('routes local model tool calls through the Vault MCP endpoint', async () => {
    const callTool = vi.fn(async () => ({ ok: true, data: { id: 'task-1' } }))
    const bridge = new AgentToolBridge({ callTool })

    await expect(
      bridge.execute({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        name: 'vault_create_task',
        args: { title: 'Ship local backend' }
      })
    ).resolves.toEqual({ ok: true, data: { id: 'task-1' } })

    expect(callTool).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      windowId: 'window-1',
      name: 'vault_create_task',
      args: { title: 'Ship local backend' }
    })
  })

  it('exposes Vault MCP schemas as AI SDK tool definitions', () => {
    const bridge = new AgentToolBridge({
      callTool: vi.fn(async () => ({ ok: true, data: null }))
    })

    const tools = createAiSdkToolSet(bridge, {
      conversationId: 'conversation-1',
      windowId: 'window-1'
    })

    expect(Object.keys(tools)).toContain('vault_create_task')
    expect(tools.vault_create_task.description).toContain('task')
    expect(tools.vault_create_task.inputSchema).toBeDefined()
  })

  it('calls the running Vault MCP server with auth and conversation context', async () => {
    mocks.clientCallTool.mockResolvedValueOnce({
      isError: false,
      structuredContent: { id: 'task-1' }
    })
    const bridge = new AgentToolBridge()

    await expect(
      bridge.execute({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        name: 'vault_create_task',
        args: { title: 'Ship local backend' }
      })
    ).resolves.toEqual({ ok: true, data: { id: 'task-1' } })

    expect(mocks.transportCtor).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3928/mcp'),
      expect.objectContaining({
        requestInit: {
          headers: {
            Authorization: 'Bearer agent-token',
            'X-Memry-Conversation': 'conversation-1',
            'X-Memry-Window': 'window-1'
          }
        }
      })
    )
    expect(mocks.clientCtor).toHaveBeenCalledWith({
      name: 'memry-agent-local',
      version: '1.0.0'
    })
    expect(mocks.clientConnect).toHaveBeenCalledWith({ type: 'transport' })
    expect(mocks.clientCallTool).toHaveBeenCalledWith({
      name: 'vault_create_task',
      arguments: { title: 'Ship local backend' }
    })
    expect(mocks.clientClose).toHaveBeenCalled()
  })

  it('returns MCP unavailable when the lifecycle has no public endpoint', async () => {
    mocks.getPublicStatus.mockReturnValueOnce({ url: null, token: null })
    const bridge = new AgentToolBridge()

    await expect(
      bridge.execute({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        name: 'vault_create_task',
        args: { title: 'Ship local backend' }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'MCP_UNAVAILABLE', message: 'Agent MCP server is not running.' }
    })

    expect(mocks.clientConnect).not.toHaveBeenCalled()
  })

  it('normalizes non-object arguments and parses text MCP results', async () => {
    mocks.clientCallTool.mockResolvedValueOnce({
      isError: false,
      content: [{ type: 'text', text: '{"id":"task-1"}' }]
    })
    const bridge = new AgentToolBridge()

    await expect(
      bridge.execute({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        name: 'vault_create_task',
        args: 'not an object'
      })
    ).resolves.toEqual({ ok: true, data: { id: 'task-1' } })

    expect(mocks.clientCallTool).toHaveBeenCalledWith({
      name: 'vault_create_task',
      arguments: {}
    })
  })

  it('returns parsed MCP tool errors without failing the whole turn', async () => {
    mocks.clientCallTool.mockResolvedValueOnce({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: { code: 'APPROVAL_REQUIRED', message: 'Approval needed' } })
        }
      ]
    })
    const bridge = new AgentToolBridge()

    await expect(
      bridge.execute({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        name: 'vault_create_task',
        args: { title: 'Ship local backend' }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'APPROVAL_REQUIRED', message: 'Approval needed' }
    })

    expect(mocks.clientClose).toHaveBeenCalled()
  })

  it('wraps transport failures as tool-call errors and still closes the client', async () => {
    mocks.clientCallTool.mockRejectedValueOnce(new Error('network down'))
    const bridge = new AgentToolBridge()

    await expect(
      bridge.execute({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        name: 'vault_create_task',
        args: { title: 'Ship local backend' }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'MCP_TOOL_CALL_FAILED', message: 'network down' }
    })

    expect(mocks.clientClose).toHaveBeenCalled()
  })
})
