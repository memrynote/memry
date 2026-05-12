import { describe, expect, it, vi } from 'vitest'

import { AgentToolBridge, createAiSdkToolSet } from '../tool-bridge'

describe('AgentToolBridge', () => {
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
})
