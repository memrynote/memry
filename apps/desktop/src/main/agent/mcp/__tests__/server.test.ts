import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AgentToolError } from '../errors'
import { startAgentMcpServer, type AgentMcpServerHandle } from '../server'

describe('Agent MCP HTTP server', () => {
  let handle: AgentMcpServerHandle

  beforeEach(async () => {
    handle = await startAgentMcpServer({ toolRegistrations: [] })
  })

  afterEach(async () => {
    await handle.stop()
  })

  it('binds to 127.0.0.1 on a random port', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const port = Number(handle.url.split(':').pop())
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })

  it('rejects requests with no Authorization header', async () => {
    const r = await fetch(`${handle.url}/mcp`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
  })

  it('rejects requests with a bad bearer token', async () => {
    const r = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer wrong-token' }
    })
    expect(r.status).toBe(401)
  })

  it('accepts a request with the right bearer token', async () => {
    const r = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${handle.token}` }
    })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toEqual({ ok: true })
  })

  it('rotates the bearer token and rejects the previous one', async () => {
    const previous = handle.token
    const next = handle.rotateToken()
    expect(next).not.toBe(previous)
    const r = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${previous}` }
    })
    expect(r.status).toBe(401)
  })
})

describe('Agent MCP server tool round-trip', () => {
  it('routes a registered tool call through the SDK', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'echo_tool',
          description: 'echo input',
          inputSchema: z.object({ msg: z.string() }),
          handler: async (input) => ({ echoed: (input as { msg: string }).msg })
        }
      ]
    })

    try {
      const r = await fetch(`${handle.url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo_tool', arguments: { msg: 'hi' } }
        })
      })

      expect(r.status).toBe(200)
      const text = await r.text()
      expect(text).toContain('"echoed":"hi"')
    } finally {
      await handle.stop()
    }
  })

  it('serves overlapping MCP tool calls without sharing a connected transport', async () => {
    let releaseFirst!: () => void
    let resolveFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve
    })
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'slow_echo_tool',
          description: 'echo input after an optional delay',
          inputSchema: z.object({ msg: z.string() }),
          handler: async (input) => {
            const msg = (input as { msg: string }).msg
            if (msg === 'first') {
              resolveFirstStarted()
              await firstCanFinish
            }
            return { echoed: msg }
          }
        }
      ]
    })

    try {
      const first = callTool(handle, 'slow_echo_tool', { msg: 'first' })
      await firstStarted
      const second = callTool(handle, 'slow_echo_tool', { msg: 'second' })
      await new Promise((resolve) => setTimeout(resolve, 25))
      releaseFirst()

      const [firstResponse, secondResponse] = await Promise.all([first, second])
      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(200)
      expect(await firstResponse.text()).toContain('"echoed":"first"')
      expect(await secondResponse.text()).toContain('"echoed":"second"')
    } finally {
      await handle.stop()
    }
  })

  it('decorates memrynote tool results with source refs for MCP clients', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'vault_search_notes',
          description: 'search notes',
          inputSchema: z.object({}),
          handler: async () => [{ id: 'note-1', title: 'Movies', snippet: '', folder_path: null }]
        }
      ]
    })

    try {
      const r = await fetch(`${handle.url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'vault_search_notes', arguments: {} }
        })
      })

      expect(r.status).toBe(200)
      const text = await r.text()
      expect(text).toContain('"href":"memry://note/note-1"')
      expect(text).toContain('"source_ref"')
    } finally {
      await handle.stop()
    }
  })

  it('replaces an existing tool registration for gate updates', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'replaceable_tool',
          description: 'first handler',
          inputSchema: z.object({}),
          handler: async () => ({ version: 'first' })
        }
      ]
    })

    try {
      handle.registerTool({
        name: 'replaceable_tool',
        description: 'second handler',
        inputSchema: z.object({}),
        handler: async () => ({ version: 'second' })
      })

      const r = await fetch(`${handle.url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'replaceable_tool', arguments: {} }
        })
      })

      expect(r.status).toBe(200)
      const text = await r.text()
      expect(text).toContain('"version":"second"')
    } finally {
      await handle.stop()
    }
  })
})

describe('Agent MCP server registration reuse', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers each tool once across sequential MCP requests', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        buildTool('tool_a', async () => ({ ok: 'a' })),
        buildTool('tool_b', async () => ({ ok: 'b' })),
        buildTool('tool_c', async () => ({ ok: 'c' }))
      ]
    })
    const registerSpy = vi.spyOn(McpServer.prototype, 'registerTool')

    try {
      await callTool(handle, 'tool_a', {})
      await callTool(handle, 'tool_b', {})
      await callTool(handle, 'tool_c', {})

      // 3 tools built once, then reused for the 2nd and 3rd request.
      expect(registerSpy).toHaveBeenCalledTimes(3)
    } finally {
      await handle.stop()
    }
  })

  it('never hands the reused server to two overlapping requests', async () => {
    let releaseFirst!: () => void
    let resolveFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve
    })
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        buildTool('overlap_tool', async (input) => {
          const msg = (input as { msg?: string }).msg
          if (msg === 'first') {
            resolveFirstStarted()
            await firstCanFinish
          }
          return { echoed: msg }
        })
      ]
    })

    try {
      // Warm the reuse slot so the overlapping pair actually contends for it.
      const warm = await callTool(handle, 'overlap_tool', { msg: 'warm' })
      expect(await warm.text()).toContain('"echoed":"warm"')

      const registerSpy = vi.spyOn(McpServer.prototype, 'registerTool')
      const first = callTool(handle, 'overlap_tool', { msg: 'first' })
      await firstStarted
      const second = callTool(handle, 'overlap_tool', { msg: 'second' })
      await new Promise((resolve) => setTimeout(resolve, 25))
      releaseFirst()
      const [firstResponse, secondResponse] = await Promise.all([first, second])

      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(200)
      expect(await firstResponse.text()).toContain('"echoed":"first"')
      expect(await secondResponse.text()).toContain('"echoed":"second"')
      // One request takes the warm instance, the other must build its own.
      expect(registerSpy).toHaveBeenCalledTimes(1)
    } finally {
      await handle.stop()
    }
  })

  it('drops a warmed server when a tool registration is replaced', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [buildTool('gated_tool', async () => ({ version: 'first' }))]
    })

    try {
      // Warm the reuse slot with the pre-replacement handler.
      const warm = await callTool(handle, 'gated_tool', {})
      expect(await warm.text()).toContain('"version":"first"')

      handle.registerTool(buildTool('gated_tool', async () => ({ version: 'second' })))

      const after = await callTool(handle, 'gated_tool', {})
      const text = await after.text()
      expect(text).toContain('"version":"second"')
      expect(text).not.toContain('"version":"first"')
    } finally {
      await handle.stop()
    }
  })

  it('never re-parks a server whose registrations changed mid-request', async () => {
    let releaseSlow!: () => void
    let resolveSlowStarted!: () => void
    const slowStarted = new Promise<void>((resolve) => {
      resolveSlowStarted = resolve
    })
    const slowCanFinish = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        buildTool('slow_gated_tool', async () => {
          resolveSlowStarted()
          await slowCanFinish
          return { version: 'first' }
        })
      ]
    })

    try {
      const slow = callTool(handle, 'slow_gated_tool', {})
      await slowStarted
      // Gate revoked while the old-gate server is still serving a request.
      handle.registerTool(buildTool('slow_gated_tool', async () => ({ version: 'second' })))
      releaseSlow()
      await slow

      const after = await callTool(handle, 'slow_gated_tool', {})
      const text = await after.text()
      expect(text).toContain('"version":"second"')
      expect(text).not.toContain('"version":"first"')
    } finally {
      await handle.stop()
    }
  })

  it('does not carry a reused server across a stop/start cycle', async () => {
    // Mirrors a vault switch: stopAgentMcpLifecycle drops the handle, then
    // startAgentMcpLifecycle rebuilds tools over the new vault's DB handles.
    const first = await startAgentMcpServer({
      toolRegistrations: [buildTool('vault_probe', async () => ({ vault: 'vault-a' }))]
    })
    const warm = await callTool(first, 'vault_probe', {})
    expect(await warm.text()).toContain('"vault":"vault-a"')
    await first.stop()

    const second = await startAgentMcpServer({
      toolRegistrations: [buildTool('vault_probe', async () => ({ vault: 'vault-b' }))]
    })
    try {
      const after = await callTool(second, 'vault_probe', {})
      const text = await after.text()
      expect(text).toContain('"vault":"vault-b"')
      expect(text).not.toContain('"vault":"vault-a"')
    } finally {
      await second.stop()
    }
  })

  it('derives conversation identity per request on a reused server', async () => {
    const seen: Array<{ conversationId: string | null; windowId: string | null }> = []
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        buildTool('ctx_probe', async (_input, ctx) => {
          seen.push({ conversationId: ctx.conversationId, windowId: ctx.windowId })
          if (!ctx.conversationId) {
            throw new AgentToolError('PERMISSION_DENIED', 'Write tools require a conversation.')
          }
          return { conversationId: ctx.conversationId }
        })
      ]
    })

    try {
      const approved = await callTool(
        handle,
        'ctx_probe',
        {},
        { 'x-memry-conversation': 'conv-a', 'x-memry-window': 'win-a' }
      )
      expect(await approved.text()).toContain('"conversationId":"conv-a"')

      // Same reused McpServer, different caller: identity must not carry over.
      const denied = await callTool(handle, 'ctx_probe', {})
      expect(await denied.text()).toContain('PERMISSION_DENIED')

      const other = await callTool(
        handle,
        'ctx_probe',
        {},
        { 'x-memry-conversation': 'conv-b', 'x-memry-window': 'win-b' }
      )
      expect(await other.text()).toContain('"conversationId":"conv-b"')

      expect(seen).toEqual([
        { conversationId: 'conv-a', windowId: 'win-a' },
        { conversationId: null, windowId: null },
        { conversationId: 'conv-b', windowId: 'win-b' }
      ])
    } finally {
      await handle.stop()
    }
  })
})

describe('Agent MCP server shutdown', () => {
  it('stops while a tool call is still in flight', async () => {
    let releaseHandler!: () => void
    let markHandlerStarted!: () => void
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve
    })
    const handlerCanFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'stuck_tool',
          description: 'blocks until released',
          inputSchema: z.object({}),
          handler: async () => {
            markHandlerStarted()
            await handlerCanFinish
            return {}
          }
        }
      ]
    })
    const inFlight = callTool(handle, 'stuck_tool', {}).catch(() => undefined)
    await handlerStarted

    try {
      await expect(withDeadline(handle.stop(), 3000)).resolves.toBe('stopped')
    } finally {
      releaseHandler()
      await inFlight
    }
  })
})

function buildTool(
  name: string,
  handler: (
    input: unknown,
    ctx: { conversationId: string | null; windowId: string | null }
  ) => Promise<unknown>
) {
  return {
    name,
    description: `${name} description`,
    inputSchema: z.object({ msg: z.string().optional() }),
    handler
  }
}

function withDeadline(promise: Promise<unknown>, ms: number): Promise<'stopped'> {
  let timer: NodeJS.Timeout
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`stop() did not resolve within ${ms}ms`)), ms)
  })
  return Promise.race([promise.then(() => 'stopped' as const), deadline]).finally(() =>
    clearTimeout(timer)
  )
}

function callTool(
  handle: AgentMcpServerHandle,
  name: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${handle.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extraHeaders
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
}
